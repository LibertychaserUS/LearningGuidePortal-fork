// BUG-0336 / BUG-0330: Backoffice showed an empty profile for a learner who had
// filled it in. The tracker's explanation was "绑定 Google 后后端查出两个账号".
// These tests pin down what the product store actually does, so the explanation is
// checked rather than assumed:
//   - linking a Google identity to the signed-in account requires the same email;
//   - signing in with Google under a *different* email creates a second account;
//   - the two accounts hold separate profiles, which is exactly how the
//     Backoffice can open the one the learner never filled in.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const originalStorageBackend = process.env.STORAGE_BACKEND;
let isolatedCwd: string;
let store: typeof import("../../services/productStore");
let sm: typeof import("../../modules/student-management/service");

before(async () => {
  isolatedCwd = await mkdtemp(path.join(tmpdir(), "lg-duplicate-account-"));
  process.chdir(isolatedCwd);
  process.env.STORAGE_BACKEND = "local";
  delete process.env.SMTP_HOST;
  store = await import("../../services/productStore");
  sm = await import("../../modules/student-management/service");
});

after(async () => {
  process.chdir(originalCwd);
  if (originalStorageBackend === undefined) delete process.env.STORAGE_BACKEND;
  else process.env.STORAGE_BACKEND = originalStorageBackend;
  if (isolatedCwd && path.dirname(isolatedCwd) === tmpdir()) await rm(isolatedCwd, { recursive: true, force: true });
});

const profile = {
  nickname: "Registered Learner",
  locale: "en-GB" as const,
  country: "Hong Kong",
  ageRange: "25–34",
  education: "Postgraduate",
  areasOfInterest: ["Philosophy"],
};

async function registeredLearner(email: string) {
  const user = await store.registerUser({ email, password: "password1", nickname: "Registered Learner" });
  await store.verifyEmailToken(await store.issueEmailVerificationToken(user.id));
  return user.id;
}

test("BUG-0336: binding Google to the signed-in account needs the same email", async () => {
  const userId = await registeredLearner("dup-a@example.test");
  await store.updateUserProfile({ userId, ...profile });

  await assert.rejects(
    () => store.linkSocialProvider({ userId, provider: "google", providerSubject: "google-sub-1", email: "other-google@example.test" }),
    (error: unknown) => error instanceof Error && /does not match/i.test(error.message),
    "a different Google email cannot be bound to this account",
  );

  assert.deepEqual(await store.socialProvidersForUser(userId), []);
  assert.equal((await sm.getStudent(userId)).profile.country, "Hong Kong");
});

test("BUG-0336: signing in with Google under a different email creates a second account", async () => {
  const userId = await registeredLearner("dup-b@example.test");
  await store.updateUserProfile({ userId, ...profile });

  const signedIn = await store.getOrCreateSocialUser({ provider: "google", providerSubject: "google-sub-2", email: "different-google@example.test", nickname: "Different", locale: "en-GB" });

  assert.notEqual(signedIn.id, userId, "the Google identity landed on a new user");
  assert.equal(signedIn.email, "different-google@example.test");

  // The learner's saved profile stayed on the account they registered with, so the
  // Backoffice sees nothing when it opens the second account.
  assert.equal((await sm.getStudent(userId)).profile.country, "Hong Kong");
  assert.deepEqual((await sm.getStudent(signedIn.id)).profile, {
    country: null,
    ageRange: null,
    education: null,
    interests: [],
    language: "en-GB",
  });
});

test("BUG-0336: a Google identity that matches the registered email lands on the same account", async () => {
  const userId = await registeredLearner("dup-c@example.test");
  await store.updateUserProfile({ userId, ...profile });

  const signedIn = await store.getOrCreateSocialUser({ provider: "google", providerSubject: "google-sub-3", email: "dup-c@example.test", nickname: "Same", locale: "en-GB" });

  assert.equal(signedIn.id, userId, "no second account for the same email");
  assert.equal((await sm.getStudent(userId)).profile.country, "Hong Kong");
});
