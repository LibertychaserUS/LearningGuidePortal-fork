// BUG-0330 (1105, BO-Student mgmt.): "在前端个人设置里填写了个人的相关信息，
// 在后端学生管理-学生详情没有展示出来". This runs the exact two functions the two
// screens call — the Settings save and the Backoffice student detail — so the claim
// is decided by the product store, not by either screen.
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
  isolatedCwd = await mkdtemp(path.join(tmpdir(), "lg-profile-roundtrip-"));
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

async function learner(email: string) {
  const user = await store.registerUser({ email, password: "password1", nickname: "Round Trip" });
  await store.verifyEmailToken(await store.issueEmailVerificationToken(user.id));
  return user.id;
}

const saved = {
  nickname: "Round Trip",
  locale: "en-GB" as const,
  country: "Hong Kong",
  ageRange: "25–34",
  education: "Postgraduate",
  areasOfInterest: ["Philosophy", "History"],
};

test("BUG-0330: what Settings saves is what Student Management reads", async () => {
  const userId = await learner("profile-roundtrip@example.test");

  await store.updateUserProfile({ userId, ...saved });

  const detail = await sm.getStudent(userId);
  assert.deepEqual(detail.profile, {
    country: "Hong Kong",
    ageRange: "25–34",
    education: "Postgraduate",
    interests: ["Philosophy", "History"],
    language: "en-GB",
  });
});

test("BUG-0330: a later save keeps the profile, and clearing one field only clears that field", async () => {
  const userId = await learner("profile-roundtrip-2@example.test");
  await store.updateUserProfile({ userId, ...saved });
  await store.updateUserProfile({ userId, ...saved, education: null, areasOfInterest: [] });

  const detail = await sm.getStudent(userId);
  assert.equal(detail.profile.country, "Hong Kong");
  assert.equal(detail.profile.ageRange, "25–34");
  assert.equal(detail.profile.education, null);
  assert.deepEqual(detail.profile.interests, []);
});

test("BUG-0330: the detail carries a Chinese-learner language through unchanged", async () => {
  const userId = await learner("profile-roundtrip-3@example.test");
  await store.updateUserProfile({ userId, ...saved, locale: "zh-CN" });

  const detail = await sm.getStudent(userId);
  assert.equal(detail.profile.language, "zh-CN");
});
