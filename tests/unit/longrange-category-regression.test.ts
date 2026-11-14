import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifiedUser, readProductData, writeProductData } from "./helpers/my-learning";

/**
 * 长程真实测试 T8 —— 分类与权益回归（保留层）。计划 §2 T8 / 设计 §7 S1–S8、
 * §5 P1–P7、C1–C4。
 *
 * 黑盒边界：只经公共入口观察行为 ——
 *  - Portal 的 Admin 分类客户端/缓存（`services/adminCatalogue.ts`、
 *    `services/adminCatalogueCache.ts`，C1/P1/P2）；
 *  - 单一解析器 `lib/coursePage.resolveCourseCategory`（P3）与
 *    `services/subscriptionSelection.activeCatalogueKeys`（P5）；
 *  - `services/productStore` 的 store API（checkEntitlement / getSubscriptionSelection）；
 *  - 真实 Next Route Handler（P6/P7 的 CMS 与旧 catalogue 写入口）。
 * 真实 HTTP：before() 起一个只实现 C1 的本地 Admin 服务器，Portal 通过真实
 * `fetch` 读取它，因此"分类单源"与"all = 全部 ACTIVE"检验的是实际链路，
 * 不是对私有字段的断言。
 *
 * Admin 独有的 C3/C4 四个绑定错误码（CATEGORY_REQUIRED / CATEGORY_NOT_FOUND /
 * CATEGORY_ARCHIVED / CATEGORY_INVALID_LEVEL）不能从 Portal 公共入口观察；本文件用
 * 一个显式 skip 记录该边界，真实行为由同任务运行的
 * `LearningGuideAdmin/server/test/category-course-binding.e2e-spec.ts` 以 HTTP e2e 证明。
 *
 * 运行：
 *   cd LearningGuidePortal && node --import tsx --require ./scripts/register-tsconfig-paths.cjs \
 *     --test tests/unit/longrange-category-regression.test.ts
 */

type CatalogueNode = {
  name: string;
  localized: Record<string, { name: string }>;
  sortOrder: number;
  children: CatalogueNode[];
};

const node = (name: string, en: string, zh: string, sortOrder: number, children: CatalogueNode[] = []): CatalogueNode => ({
  name,
  localized: { "en-GB": { name: en }, "zh-CN": { name: zh } },
  sortOrder,
  children,
});

/** C1 fixture served over real HTTP: five ACTIVE top-level categories + one nested child. */
const CATALOGUE: CatalogueNode[] = [
  node("Science", "Science", "科学", 0, [node("Physics", "Physics", "物理", 0)]),
  node("Chinese Humanities", "Chinese Humanities", "中国人文", 1),
  node("European Humanities", "European Humanities", "欧洲人文", 2),
  node("Society", "Society", "社会", 3),
  node("Mathematics", "Mathematics", "数学", 4),
];
const ACTIVE_KEYS = CATALOGUE.flatMap((entry) => [entry.name, ...entry.children.map((child) => child.name)]);

const cwd = process.cwd();
const environment = { ...process.env };
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

let directory: string;
let adminServer: Server;
let adminRequests: Array<{ url: string; apiKey: string | null; cache: string | null }> = [];
let store: typeof import("../../services/productStore");
let catalogueClient: typeof import("../../services/adminCatalogue");
let catalogueCache: typeof import("../../services/adminCatalogueCache");
let coursePage: typeof import("../../lib/coursePage");
let subscriptionSelection: typeof import("../../services/subscriptionSelection");
let cmsRoute: typeof import("../../app/api/backoffice/portal/route");
let catalogueRoute: typeof import("../../app/api/backoffice/courses/catalogue/route");
let catalogueEntryRoute: typeof import("../../app/api/backoffice/courses/catalogue/[entryId]/route");
let operatorToken: string;

function startAdminCatalogueServer(): Promise<Server> {
  const server = createServer((request, response) => {
    adminRequests.push({
      url: request.url || "",
      apiKey: (request.headers["x-api-key"] as string | undefined) ?? null,
      cache: (request.headers["cache-control"] as string | undefined) ?? null,
    });
    if (request.url !== "/api/portal/v1/categories") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, data: null, error: "not found", message: "" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: true, data: CATALOGUE, error: null, message: "" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lg-longrange-category-"));
  adminServer = await startAdminCatalogueServer();
  const address = adminServer.address();
  assert.ok(address && typeof address === "object");
  const adminBase = `http://127.0.0.1:${address.port}`;

  process.chdir(directory);
  Object.assign(process.env, {
    STORAGE_BACKEND: "local",
    APP_ENV: "DEV",
    PAYMENT_MODE: "demo",
    ADMIN_PORTAL_BASE_URL: adminBase,
    ADMIN_PORTAL_API_TOKEN: "longrange-admin-token",
    ADMIN_HOSTS: "localhost",
    BACKOFFICE_OPERATOR_EMAIL: "operator@longrange-category.test",
  });
  for (const key of ["KS_TUTOR_BASE_URL", "KS_TUTOR_API_KEY", "OPENROUTER_API_KEY"]) delete process.env[key];

  store = await import("../../services/productStore");
  catalogueClient = await import("../../services/adminCatalogue");
  catalogueCache = await import("../../services/adminCatalogueCache");
  coursePage = await import("../../lib/coursePage");
  subscriptionSelection = await import("../../services/subscriptionSelection");
  cmsRoute = await import("../../app/api/backoffice/portal/route");
  catalogueRoute = await import("../../app/api/backoffice/courses/catalogue/route");
  catalogueEntryRoute = await import("../../app/api/backoffice/courses/catalogue/[entryId]/route");

  catalogueCache.clearAdminCatalogueCache();
  const operator = await store.registerUser({ email: "operator@longrange-category.test", password: "password1", role: "operator" });
  await store.verifyEmailToken(await store.issueEmailVerificationToken(operator.id));
  operatorToken = (await store.createSession(operator.id)).token;
});

after(async () => {
  process.chdir(cwd);
  process.env = environment;
  if (adminServer) await new Promise<void>((resolve) => adminServer.close(() => resolve()));
  if (directory && path.dirname(directory) === tmpdir()) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

type LooseData = {
  courses: any[];
  plans: any[];
  subscriptions: any[];
  entitlements: any[];
  [key: string]: any;
};

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

function categoryPlan(id: string, scopeId: string, displayLabel: string = scopeId) {
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
    aiPoints: 3000,
    trialEligible: false,
  };
}

function subscriptionFixture(userId: string, planId: string, scopeId: string, index: number) {
  return {
    id: `longrange-sub-${index}-${scopeId.replace(/\s+/g, "-").toLowerCase()}`,
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

function backofficeRequest(method: string, pathname: string, body?: unknown) {
  return new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "content-type": "application/json",
      cookie: `learning_guide_admin_session=${operatorToken}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ---------------------------------------------------------------------------
// C1/P1/S6 — the Admin catalogue is the only category source, read over HTTP.
// ---------------------------------------------------------------------------
test("[T8][S6][C1][P1] Portal reads the C1 catalogue over real HTTP with the API key and no local copy", async () => {
  catalogueCache.clearAdminCatalogueCache();
  const tree = await catalogueClient.createAdminCatalogueClient().getCatalogue();

  assert.deepEqual(
    tree.map((entry) => entry.name),
    CATALOGUE.map((entry) => entry.name),
    "Portal must return exactly the Admin C1 tree (no locally invented category)",
  );
  assert.deepEqual(tree[0].children.map((child) => child.name), ["Physics"], "nested ACTIVE nodes are preserved");

  const request = adminRequests[adminRequests.length - 1];
  assert.equal(request.url, "/api/portal/v1/categories", "only the C1 endpoint is read (single source)");
  assert.equal(request.apiKey, "longrange-admin-token", "the Admin API key travels in X-API-Key");
  // The client passes `cache: "no-store"`; on the wire undici emits the
  // equivalent non-shared-cache directive (`no-cache`). Either form proves the
  // catalogue read is not served from a shared cache.
  assert.ok(
    request.cache === "no-store" || request.cache === "no-cache",
    `the catalogue read carries a non-shared-cache directive (got ${String(request.cache)})`,
  );
});

test("[T8][S6][C1] a non-C1 envelope is rejected, never partially accepted or guessed", async () => {
  const deps = {
    fetch: (async () => new Response(JSON.stringify({ success: true, data: [{ name: "Only Name" }], error: null }), { status: 200 })) as typeof fetch,
    timeouts: { request: 500 },
  };
  await assert.rejects(
    () => catalogueClient.createAdminCatalogueClient(deps).getCatalogue(),
    (error: unknown) => (error as { code?: string }).code === "invalid_response",
    "a node without localized/sortOrder/children is not a category and must be rejected",
  );
});

// ---------------------------------------------------------------------------
// P2/S6 — cold-start degradation is the fixed design seed, not a guessed list.
// ---------------------------------------------------------------------------
test("[T8][S6][P2] Admin unavailable at cold start falls back to the four preset categories", async () => {
  const offline = {
    fetch: (async () => { throw new Error("connection refused"); }) as typeof fetch,
    timeouts: { request: 500 },
  };
  const cache = catalogueCache.createAdminCatalogueCache(offline);
  const tree = await cache.getCatalogue();
  assert.deepEqual(tree.map((entry) => entry.name), ["Science", "Chinese Humanities", "European Humanities", "Society"]);
  assert.equal(tree[3].localized["zh-CN"].name, "社会", "the seed carries the Admin localized template, not an English-only fallback");
});

// ---------------------------------------------------------------------------
// P3/S7 — one resolver: stable key only; display names never match.
// ---------------------------------------------------------------------------
test("[T8][S7][P3] resolveCourseCategory matches the stable key (case/trim) and never a display name", async () => {
  const resolved = coursePage.resolveCourseCategory({ categoryKey: "  society " }, CATALOGUE);
  assert.ok(resolved, "the stable key Society resolves");
  assert.equal(resolved.name, "Society");
  assert.equal(resolved.localized["zh-CN"].name, "社会");

  const nested = coursePage.resolveCourseCategory({ categoryKey: "Physics" }, CATALOGUE);
  assert.equal(nested?.name, "Physics", "nested ACTIVE categories resolve through the same resolver");

  assert.equal(coursePage.resolveCourseCategory({ categoryKey: "社会" }, CATALOGUE), null, "a display name is not a stable key");
  assert.equal(coursePage.resolveCourseCategory({ categoryKey: null }, CATALOGUE), null);
  assert.equal(coursePage.resolveCourseCategory({ categoryKey: "Uncategorized" }, CATALOGUE), null, "no default-category fallback");
});

// ---------------------------------------------------------------------------
// P5/S7 — "all ACTIVE" is derived from the live Admin tree.
// ---------------------------------------------------------------------------
test("[T8][S7][P5] activeCatalogueKeys returns every ACTIVE key from the Admin tree (nested included)", async () => {
  const keys = subscriptionSelection.activeCatalogueKeys(CATALOGUE);
  assert.deepEqual(keys, ACTIVE_KEYS);
  assert.ok(keys.includes("Society") && keys.includes("Physics") && keys.includes("Mathematics"));
  assert.ok(!keys.includes("社会"), "localized display names are not keys");
});

// ---------------------------------------------------------------------------
// P5/S8 — entitlement coverage by stable scope key; all = every ACTIVE category.
// ---------------------------------------------------------------------------
test("[T8][S8][P5] a category scope covers only its stable-key course, independent of display labels", async () => {
  const user = await verifiedUser(store, "longrange-entitlement-society@example.test");
  const data = await productData();
  data.plans.push(categoryPlan("longrange-society-pc-6", "Society", "社会"));
  data.courses.push(
    courseFixture("longrange-society-course", "Society"),
    courseFixture("longrange-european-course", "European Humanities"),
    courseFixture("longrange-display-name-course", "社会"),
  );
  await writeProductData(data);

  const { quote } = await store.createQuote(user.id, "longrange-society-pc-6");
  await store.completeDemoCheckout(user.id, quote.id);

  assert.equal((await store.checkEntitlement(user.id, "longrange-society-course")).allowed, true, "Society scope covers the stable-key Society course");
  assert.equal((await store.checkEntitlement(user.id, "longrange-european-course")).allowed, false, "Society scope does not cover European Humanities");
  assert.equal((await store.checkEntitlement(user.id, "longrange-display-name-course")).allowed, false, "a display-name categoryKey is uncovered (no local name matching)");
});

test("[T8][S8][P5] all-categories means every ACTIVE Admin category: 5 of 6 is not all, 6 of 6 is", async () => {
  const user = await verifiedUser(store, "longrange-entitlement-all@example.test");
  const data = await productData();
  const owned = ACTIVE_KEYS.slice(0, ACTIVE_KEYS.length - 1);
  for (const [index, key] of owned.entries()) {
    const planId = `longrange-all-${index}`;
    data.plans.push(categoryPlan(planId, key));
    data.subscriptions.push(subscriptionFixture(user.id, planId, key, index));
  }
  await writeProductData(data);
  catalogueCache.clearAdminCatalogueCache();

  const partial = await store.getSubscriptionSelection(user.id);
  assert.notEqual(partial.kind, "all_categories", `owning ${owned.length} of ${ACTIVE_KEYS.length} ACTIVE categories is not "all"`);
  assert.equal(partial.kind, "multiple_categories");

  const missing = ACTIVE_KEYS[ACTIVE_KEYS.length - 1];
  const withAll = await productData();
  withAll.plans.push(categoryPlan("longrange-all-last", missing));
  withAll.subscriptions.push(subscriptionFixture(user.id, "longrange-all-last", missing, ACTIVE_KEYS.length));
  await writeProductData(withAll);
  catalogueCache.clearAdminCatalogueCache();

  const complete = await store.getSubscriptionSelection(user.id);
  assert.equal(complete.kind, "all_categories", "owning every ACTIVE Admin category is all categories");
});

// ---------------------------------------------------------------------------
// P6/P7/S8 — category writes stay in Admin.
// ---------------------------------------------------------------------------
test("[T8][S8][P6][P7] Portal CMS/catalogue writes reject category changes with the managed-in-Admin codes", async () => {
  const cmsPayload = (await store.getPortalContent()) as any;
  cmsPayload.categories = [{ id: "local", name: "Locally invented", labels: { "en-GB": "Locally invented" } }];
  const cmsResponse = await cmsRoute.PUT(backofficeRequest("PUT", "/api/backoffice/portal", cmsPayload));
  assert.equal(cmsResponse.status, 422, "P6: category payloads are rejected");
  assert.ok(JSON.stringify(await cmsResponse.json()).includes("CATEGORIES_MANAGED_IN_ADMIN"));

  const created = await catalogueRoute.POST(backofficeRequest("POST", "/api/backoffice/courses/catalogue", { name: "From Portal" }));
  assert.equal(created.status, 410, "P7: legacy catalogue writes are closed");
  assert.ok(JSON.stringify(await created.json()).includes("CATALOGUE_MANAGED_IN_ADMIN"));

  const patched = await catalogueEntryRoute.PATCH(
    backofficeRequest("PATCH", "/api/backoffice/courses/catalogue/entry-x", { name: "Renamed" }),
    { params: Promise.resolve({ entryId: "entry-x" }) },
  );
  assert.equal(patched.status, 410);
  assert.ok(JSON.stringify(await patched.json()).includes("CATALOGUE_MANAGED_IN_ADMIN"));

  const read = await catalogueRoute.GET(backofficeRequest("GET", "/api/backoffice/courses/catalogue"));
  assert.equal(read.status, 200, "P7: reads stay available during the read-only transition");
});

// ---------------------------------------------------------------------------
// P5/P2 — RED (implementation defect): cold-start seed must not over-claim "all".
// ---------------------------------------------------------------------------
test("[T8][S8][P5][P2][RED] with the Admin catalogue unreachable at cold start, owning the 4 seed categories must not report all_categories", async () => {
  const user = await verifiedUser(store, "longrange-entitlement-degraded@example.test");
  const data = await productData();
  const seedKeys = ["Science", "Chinese Humanities", "European Humanities", "Society"];
  for (const [index, key] of seedKeys.entries()) {
    const planId = `longrange-degraded-${index}`;
    data.plans.push(categoryPlan(planId, key));
    data.subscriptions.push(subscriptionFixture(user.id, planId, key, index));
  }
  await writeProductData(data);

  // Admin is unreachable: the cache cold-starts from the built-in four-category seed.
  process.env.ADMIN_PORTAL_BASE_URL = "http://127.0.0.1:1";
  catalogueCache.clearAdminCatalogueCache();

  const selection = await store.getSubscriptionSelection(user.id);
  assert.notEqual(
    selection.kind,
    "all_categories",
    "P5 defines all categories as every ACTIVE Admin category; the four-category cold-start seed is not the live directory and must not over-claim 'all' (P2 only requires the page not to crash)",
  );
});

// ---------------------------------------------------------------------------
// C3/C4 — Admin-only category binding codes (explicit boundary, proved by Admin e2e).
// ---------------------------------------------------------------------------
test("[T8][S3][C3][C4] four category binding error codes are Admin-only and proved by the Admin HTTP e2e", {
  skip: "CATEGORY_REQUIRED / CATEGORY_NOT_FOUND / CATEGORY_ARCHIVED / CATEGORY_INVALID_LEVEL are returned by Admin's course create/update HTTP API (C3/C4). A Portal public entry cannot observe them by design; this task runs LearningGuideAdmin/server/test/category-course-binding.e2e-spec.ts for the real HTTP proof.",
}, () => {});
