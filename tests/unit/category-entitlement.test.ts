import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifiedUser, readProductData, writeProductData } from "./helpers/my-learning";

// S8 — Portal entitlement (black-box TDD spec).
//
// Design SSOT: /Users/nihao/AI infra/LearningGuideAdmin/docs/Course_Category_Single_Source_Design.md
//   P5  scopeId/Entitlement scope semantics are the category stable key; coverage is
//       resolved(course).name === scope.key; "all categories" = every ACTIVE catalogue
//       category covered (no >= 3 magic number); AI points come from plan data.
//   P3  ProductCourse carries only the stable category key (categoryKey: string | null);
//       course display names come from Admin localized names and never decide matching.
//   I7  a course has one category membership; unclassified courses are valid but uncovered.
//
// The suite observes only public entries: services/productStore's store API
// (checkEntitlement, getSubscriptionSelection, purchase flow) and the on-disk product
// fixture that the existing unit tests already use. No private helper is imported.
// With no Admin catalogue env configured, P2's cold-start fallback is the deterministic
// four-category seed (Science / Chinese Humanities / European Humanities / Society).

const cwd = process.cwd();
const environment = { ...process.env };
let directory: string;
let store: typeof import("../../services/productStore");

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lg-category-entitlement-"));
  process.chdir(directory);
  Object.assign(process.env, { STORAGE_BACKEND: "local", APP_ENV: "DEV", PAYMENT_MODE: "demo" });
  // Force P2's built-in four-category seed: no Admin origin/token, so no HTTP request is made.
  for (const key of ["ADMIN_PORTAL_BASE_URL", "ADMIN_PORTAL_API_TOKEN", "KS_TUTOR_BASE_URL", "KS_TUTOR_API_KEY"]) delete process.env[key];
  store = await import("../../services/productStore");
});

after(async () => {
  process.chdir(cwd);
  process.env = environment;
  if (directory && path.dirname(directory) === tmpdir()) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

type LooseData = {
  courses: any[];
  plans: any[];
  subscriptions: any[];
  entitlements: any[];
  [key: string]: any;
};

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

async function productData(): Promise<LooseData> {
  await store.ensureProductData();
  return await readProductData() as LooseData;
}

function courseFixture(id: string, categoryKey: string | null) {
  return {
    id,
    slug: id,
    title: `${id} course`,
    description: "",
    status: "published",
    sections: [],
    createdAt: iso(0),
    updatedAt: iso(0),
    categoryKey,
  };
}

function categoryPlan(id: string, scopeId: string, aiPoints: number, displayLabel: string = scopeId) {
  return {
    id,
    courseId: "*",
    name: `${scopeId} · PC · 6 months`,
    termMonths: 6,
    device: "pc",
    amountMinor: 5900,
    currency: "usd",
    scope: "category",
    scopeId,
    category: displayLabel,
    aiPoints,
    trialEligible: false,
  };
}

function subscriptionFixture(userId: string, planId: string, scopeId: string, index: number) {
  return {
    id: `sub-${index}-${scopeId.replace(/\s+/g, "-").toLowerCase()}`,
    userId,
    planId,
    courseId: "*",
    state: "active",
    source: "purchase",
    validFrom: iso(-10),
    validTo: iso(200),
    cancelAtPeriodEnd: false,
    scope: "category",
    scopeId,
    device: "pc",
  };
}

async function buy(userId: string, planId: string) {
  const { quote } = await store.createQuote(userId, planId);
  await store.completeDemoCheckout(userId, quote.id);
}

// P5 — scopeId is the category stable key: a Society plan covers a course whose stable
// category key is Society and must not cover a course in another category.
test("P5: a Society scope covers the Society-keyed course and not a European Humanities course", async () => {
  const user = await verifiedUser(store, "entitlement-society@example.test");
  const data = await productData();
  data.plans.push(categoryPlan("society-pc-6", "Society", 3000));
  data.courses.push(courseFixture("society-course", "Society"), courseFixture("european-course", "European Humanities"));
  await writeProductData(data);
  await buy(user.id, "society-pc-6");

  assert.equal(
    (await store.checkEntitlement(user.id, "society-course")).allowed,
    true,
    "P5: a Society category subscription must cover a course whose stable category key is Society",
  );
  assert.equal(
    (await store.checkEntitlement(user.id, "european-course")).allowed,
    false,
    "P5: a Society category subscription must not cover a European Humanities course",
  );
});

// P5/P3 — display names are presentation only; the stable key decides coverage. Changing the
// localized/label text keeps coverage, while a changed stable name falls out of the old scope.
test("P5/P3: display-label changes keep coverage; a changed stable category name loses the old scope", async () => {
  const user = await verifiedUser(store, "entitlement-display@example.test");
  const data = await productData();
  // The plan keeps scopeId "Society" (stable key) but its display label is the Chinese name.
  data.plans.push(categoryPlan("society-display-pc-6", "Society", 3000, "社会"));
  data.courses.push(
    courseFixture("society-display-course", "Society"),
    courseFixture("society-renamed-course", "Society Legacy"),
  );
  await writeProductData(data);
  await buy(user.id, "society-display-pc-6");

  assert.equal(
    (await store.checkEntitlement(user.id, "society-display-course")).allowed,
    true,
    "P5: changing the category display label must not change entitlement coverage (matching is by stable key)",
  );
  assert.equal(
    (await store.checkEntitlement(user.id, "society-renamed-course")).allowed,
    false,
    "P5: after the category's stable name changes, the old scope no longer covers the course",
  );
});

// P5 — "all categories" means every ACTIVE category in the catalogue (the P2 seed has four:
// Science, Chinese Humanities, European Humanities, Society). Owning three of four must not be
// reported as all (the old >= 3 magic number is forbidden).
test("P5: all-categories requires all four ACTIVE categories; three of four is not all", async () => {
  const user = await verifiedUser(store, "entitlement-all@example.test");
  const data = await productData();
  data.plans.push(categoryPlan("society-four-pc-6", "Society", 3000));
  data.subscriptions.push(
    subscriptionFixture(user.id, "european-humanities-pc-6", "European Humanities", 1),
    subscriptionFixture(user.id, "science-pc-6", "Science", 2),
    subscriptionFixture(user.id, "chinese-humanities-pc-6", "Chinese Humanities", 3),
  );
  await writeProductData(data);
  const threeOfFour = await store.getSubscriptionSelection(user.id);
  assert.notEqual(
    threeOfFour.kind,
    "all_categories",
    "P5: owning 3 of the 4 ACTIVE categories must not be 'all categories' (no >= 3 magic number)",
  );

  const withSociety = await productData();
  withSociety.subscriptions.push(subscriptionFixture(user.id, "society-four-pc-6", "Society", 4));
  await writeProductData(withSociety);
  const fourOfFour = await store.getSubscriptionSelection(user.id);
  assert.equal(
    fourOfFour.kind,
    "all_categories",
    "P5: owning every ACTIVE category (4 of 4) is 'all categories'",
  );
});

// P5/I7 — an uncategorised course (categoryKey null) is covered by no category plan; the design
// forbids any default-category fallback such as `|| 'European Humanities'`.
test("P5: an uncategorised course is not covered by any category plan", async () => {
  const user = await verifiedUser(store, "entitlement-uncategorised@example.test");
  const data = await productData();
  data.courses.push(courseFixture("uncategorised-course", null));
  await writeProductData(data);
  await buy(user.id, "european-humanities-pc-6");

  assert.equal(
    (await store.checkEntitlement(user.id, "uncategorised-course")).allowed,
    false,
    "P5: no category scope covers an uncategorised course (no default-category fallback)",
  );
});

// P5 — the AI allowance shown for a subscription is the plan record's aiPoints, not a hardcoded
// per-category-number tier: changing the plan data changes the reported allowance.
test("P5: AI points come from the plan record and follow plan data changes", async () => {
  const user = await verifiedUser(store, "entitlement-ai-points@example.test");
  const data = await productData();
  data.plans.push(categoryPlan("society-points-pc-6", "Society", 4321));
  data.subscriptions.push(subscriptionFixture(user.id, "society-points-pc-6", "Society", 1));
  await writeProductData(data);
  assert.equal(
    (await store.getSubscriptionSelection(user.id)).categorySubscription?.aiPoints,
    4321,
    "P5: the subscription's AI allowance must be the plan's aiPoints value",
  );

  const updated = await productData();
  updated.plans.find((plan: any) => plan.id === "society-points-pc-6").aiPoints = 8765;
  await writeProductData(updated);
  assert.equal(
    (await store.getSubscriptionSelection(user.id)).categorySubscription?.aiPoints,
    8765,
    "P5: changing plan data changes the allowance (the value is data-driven, not hardcoded)",
  );
});
