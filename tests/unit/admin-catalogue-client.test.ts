import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

// S6 — Portal Admin category client and cache (black-box TDD spec).
//
// Design SSOT: /Users/nihao/AI infra/LearningGuideAdmin/docs/Course_Category_Single_Source_Design.md
//   C1  GET /api/portal/v1/categories -> { success:true, data:[node], error:null, message }
//       node = { name, localized, sortOrder, children:[node] }  (nested ACTIVE tree, no UUIDs)
//   P1  server-only client, env priority ADMIN_PORTAL_BASE_URL / ADMIN_PORTAL_API_TOKEN,
//       fallback KS_TUTOR_BASE_URL / KS_TUTOR_API_KEY; GET /api/portal/v1/categories with
//       X-API-Key, cache:'no-store', timeout <= 3 s; credentials never reach logs.
//   P2  in-memory TTL 60 s, single-flight, 15 s failure backoff, keep last-good; a cold-start
//       failure returns the built-in seed (Science / Chinese Humanities / European Humanities /
//       Society, with Chinese names) and never throws at the page.
//
// Public entry contract exercised below (black box; no private fields are inspected):
//   services/adminCatalogue.ts
//     export const ADMIN_CATALOGUE_TIMEOUT_MS: number            // <= 3000
//     export function createAdminCatalogueClient(deps?): { getCatalogue(): Promise<AdminCatalogueNode[]> }
//       deps = { fetch?, now?, log?, timeouts?: { request?: number } }
//     getCatalogue() resolves the C1 tree or rejects; it never returns partial/dirty data.
//   services/adminCatalogueCache.ts
//     export function createAdminCatalogueCache(deps?): { getCatalogue(): Promise<AdminCatalogueNode[]>; clear(): void }
//       deps = { fetch?, now?, log?, timeouts?: { request?: number } }
//     getCatalogue() never rejects: fresh cache -> last-good -> built-in seed.
//   AdminCatalogueNode = { name: string; localized: { [locale: string]: { name: string } };
//                          sortOrder: number; children: AdminCatalogueNode[] }
//
// Both modules are new in this refactor; until they exist the tests fail at the dynamic import
// with an explicit "missing public entry" assertion (a behaviour gap, not a compile error).

type CatalogueNode = {
  name: string;
  localized: Record<string, { name?: string } | undefined>;
  sortOrder: number;
  children: CatalogueNode[];
};

type CatalogueClientDeps = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
  timeouts?: { request?: number };
};

type CatalogueClient = { getCatalogue(): Promise<CatalogueNode[]> };
type CatalogueCache = CatalogueClient & {
  clear(): void;
  getSnapshot?(): Promise<{ tree: CatalogueNode[]; source: "live" | "last-good" | "preset" | "seed" }>;
};

const BASE = "http://admin.local:3100";
const TOKEN = "local-test-admin-catalogue-token";

const ENV_KEYS = ["ADMIN_PORTAL_BASE_URL", "ADMIN_PORTAL_API_TOKEN", "KS_TUTOR_BASE_URL", "KS_TUTOR_API_KEY"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const logs: Array<Record<string, unknown>> = [];

beforeEach(() => {
  process.env.ADMIN_PORTAL_BASE_URL = `${BASE}/`;
  process.env.ADMIN_PORTAL_API_TOKEN = TOKEN;
  delete process.env.KS_TUTOR_BASE_URL;
  delete process.env.KS_TUTOR_API_KEY;
  logs.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type Call = {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  cache: RequestCache | undefined;
  signal: AbortSignal | undefined;
};

function stubFetch(handler: (call: Call, signal: AbortSignal | undefined) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method || "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : null,
      cache: init.cache,
      signal: init.signal ?? undefined
    };
    calls.push(call);
    return handler(call, init.signal ?? undefined);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (data: unknown) => ({ success: true, data, error: null, message: "" });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const plain = (node: CatalogueNode): unknown => ({
  name: node.name,
  localized: node.localized,
  sortOrder: node.sortOrder,
  children: node.children.map(plain)
});

// C1 fixtures: the Admin localized template is { "en-GB": { name }, "zh-CN": { name } }.
const SCIENCE: CatalogueNode = {
  name: "Science",
  localized: { "en-GB": { name: "Science" }, "zh-CN": { name: "科学" } },
  sortOrder: 0,
  children: []
};
const PHILOSOPHY: CatalogueNode = {
  name: "Philosophy",
  localized: { "en-GB": { name: "Philosophy" }, "zh-CN": { name: "哲学" } },
  sortOrder: 0,
  children: []
};
const EUROPEAN: CatalogueNode = {
  name: "European Humanities",
  localized: { "en-GB": { name: "European Humanities" }, "zh-CN": { name: "欧洲人文" } },
  sortOrder: 2,
  children: [PHILOSOPHY]
};
const SOCIETY: CatalogueNode = {
  name: "Society",
  localized: { "en-GB": { name: "Society" }, "zh-CN": { name: "社会" } },
  sortOrder: 3,
  children: []
};
const TREE: CatalogueNode[] = [SCIENCE, EUROPEAN];

type ServiceModule = Record<string, unknown>;

async function loadService(relative: string): Promise<ServiceModule> {
  try {
    return (await import(relative)) as ServiceModule;
  } catch (error) {
    assert.fail(`missing S6 public entry ${relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function clientFactory() {
  const service = await loadService("../../services/adminCatalogue");
  assert.equal(typeof service.createAdminCatalogueClient, "function", "services/adminCatalogue.ts must export createAdminCatalogueClient(deps) [P1]");
  return service.createAdminCatalogueClient as (deps?: CatalogueClientDeps) => CatalogueClient;
}

async function cacheFactory() {
  const service = await loadService("../../services/adminCatalogueCache");
  assert.equal(typeof service.createAdminCatalogueCache, "function", "services/adminCatalogueCache.ts must export createAdminCatalogueCache(deps) [P2]");
  return service.createAdminCatalogueCache as (deps?: CatalogueClientDeps) => CatalogueCache;
}

// Spec: P1 — the Admin request shape (env-selected origin, X-API-Key, no-store, GET).
// C1 — the path is exactly /api/portal/v1/categories.
test("P1: GET {base}/api/portal/v1/categories with X-API-Key and no-store; the token never becomes a query or a log line", async () => {
  const stub = stubFetch(() => json(envelope(TREE)));
  const createClient = await clientFactory();
  const client = createClient({ fetch: stub.fetch, log: (line) => logs.push(line) });

  assert.deepEqual((await client.getCatalogue()).map(plain), TREE);
  assert.equal(stub.calls.length, 1);
  const [call] = stub.calls;
  assert.equal(call.method, "GET");
  assert.equal(call.url, `${BASE}/api/portal/v1/categories`);
  assert.equal(call.headers.get("x-api-key"), TOKEN);
  assert.equal(call.headers.get("authorization"), null, "P1 names X-API-Key, not a bearer header");
  assert.equal(call.cache, "no-store", "P1: cache:'no-store'");
  assert.ok(!call.url.includes(TOKEN), "the token is never a query parameter");
  assert.ok(!JSON.stringify(logs).includes(TOKEN), "the token is never logged");
});

// Spec: C1 — success envelope and node tree; P1 — the client parses C1 into the tree.
test("C1/P1: parses {success:true,data} into the nested category tree, keeping localized names and order", async () => {
  const stub = stubFetch(() => json({ success: true, data: TREE, error: null, message: "ok" }));
  const client = (await clientFactory())({ fetch: stub.fetch });

  const tree = await client.getCatalogue();
  assert.ok(Array.isArray(tree), "data is returned as a category list");
  assert.deepEqual(tree.map(plain), TREE);
  assert.equal(tree[1].children[0].localized["zh-CN"]?.name, "哲学");
});

// Spec: C1 — only {success:true,data:[node]} is a success; P1 — failures are errors, never
// dirty data handed to the page.
test("C1/P1: malformed envelopes, missing/non-array data, malformed nodes, non-2xx and non-JSON are errors, not dirty data", async () => {
  const createClient = await clientFactory();
  const responses: Array<() => Response> = [
    () => json({}),
    () => json({ success: false, data: TREE }),
    () => json({ success: true }),
    () => json({ success: true, data: null }),
    () => json({ success: true, data: {} }),
    () => json({ success: true, data: "Science" }),
    () => json({ success: true, data: [{ name: "Science", localized: {}, sortOrder: 0, children: "nope" }] }),
    () => json({ success: true, data: [{ localized: {}, sortOrder: 0, children: [] }] }),
    () => json({ success: true, data: TREE }, 500),
    () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })
  ];

  for (const response of responses) {
    const stub = stubFetch(response);
    const client = createClient({ fetch: stub.fetch, log: (line) => logs.push(line) });
    await assert.rejects(client.getCatalogue(), "a non-success body must reject, not leak partial data");
    assert.equal(stub.calls.length, 1);
  }
  assert.ok(!JSON.stringify(logs).includes(TOKEN), "failures never log the credential (P1)");
});

// Spec: P2 — in-memory TTL 60 s. Inside the window one HTTP request serves every read; the
// expiry triggers a new request and the refreshed tree is what later reads see.
test("P2: a catalogue is reused for 60 s (one HTTP request), then refetched at the TTL boundary", async () => {
  let clock = 1_000_000;
  let tree = TREE;
  const stub = stubFetch(() => json(envelope(tree)));
  const cache = (await cacheFactory())({ fetch: stub.fetch, now: () => clock });

  assert.equal((await cache.getCatalogue()).length, 2);
  clock += 59_999;
  assert.equal((await cache.getCatalogue()).length, 2);
  assert.equal(stub.calls.length, 1, "inside 60 s: one HTTP request");

  clock += 1; // exactly 60_000 ms after the first fetch
  tree = [...TREE, SOCIETY];
  await cache.getCatalogue();
  await settle();
  assert.equal(stub.calls.length, 2, "TTL expiry asks Admin again");
  assert.equal((await cache.getCatalogue()).length, 3, "the refreshed tree is served afterwards");
});

// Spec: P2 — single-flight: concurrent cold readers share one request.
test("P2: ten concurrent cold reads share one in-flight HTTP request (single-flight)", async () => {
  let release: (response: Response) => void = () => undefined;
  const stub = stubFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
  const cache = (await cacheFactory())({ fetch: stub.fetch, now: () => 5_000_000 });

  const reads = Array.from({ length: 10 }, () => cache.getCatalogue());
  await settle();
  assert.equal(stub.calls.length, 1, "ten readers, one Admin request");

  release(json(envelope(TREE)));
  const results = await Promise.all(reads);
  assert.equal(stub.calls.length, 1);
  for (const tree of results) assert.deepEqual(tree.map(plain), TREE);
});

// Spec: P2 — after a failure, keep last-good and do not ask Admin again for 15 s; then retry.
test("P2: an Admin 500 after the TTL serves last-good and suppresses requests for 15 s, then retries", async () => {
  let clock = 3_000_000;
  let mode: "ok" | "fail" = "ok";
  let tree = TREE;
  const callTimes: number[] = [];
  const stub = stubFetch(() => {
    callTimes.push(clock);
    return mode === "fail" ? json({ success: false, error: { code: "CATALOGUE_UNAVAILABLE" } }, 500) : json(envelope(tree));
  });
  const cache = (await cacheFactory())({ fetch: stub.fetch, now: () => clock, log: (line) => logs.push(line) });

  await cache.getCatalogue(); // request 1 at 3_000_000
  clock += 60_000;
  mode = "fail";
  assert.deepEqual((await cache.getCatalogue()).map(plain), TREE, "last-good is returned when the refresh fails");
  await settle();
  assert.equal(stub.calls.length, 2, "the TTL expiry made the failed request");

  clock += 14_999;
  assert.deepEqual((await cache.getCatalogue()).map(plain), TREE);
  await settle();
  assert.equal(stub.calls.length, 2, "no request inside the 15 s backoff");

  clock += 1;
  mode = "ok";
  tree = [...TREE, SOCIETY];
  await cache.getCatalogue();
  await settle();
  assert.deepEqual(callTimes, [3_000_000, 3_060_000, 3_075_000], "one request per retry window, retried after 15 s");
  assert.equal((await cache.getCatalogue()).length, 3, "the successful retry replaces last-good");
  assert.ok(!JSON.stringify(logs).includes(TOKEN), "the credential never reaches logs (P1)");
});

// Spec: P2 — only a valid C1 payload may become last-good; P1 — a dirty success is a failure.
test("P2/C1: a malformed success response never replaces last-good; it is treated as a failure and backs off", async () => {
  let clock = 4_000_000;
  let body: unknown = envelope(TREE);
  const stub = stubFetch(() => json(body));
  const cache = (await cacheFactory())({ fetch: stub.fetch, now: () => clock });

  await cache.getCatalogue();
  clock += 60_000;
  body = { success: true }; // dirty success (missing data)
  assert.deepEqual((await cache.getCatalogue()).map(plain), TREE, "last-good survives a malformed success");
  await settle();
  assert.equal(stub.calls.length, 2);

  clock += 14_999;
  assert.deepEqual((await cache.getCatalogue()).map(plain), TREE);
  await settle();
  assert.equal(stub.calls.length, 2, "the malformed success started the 15 s backoff too");

  clock += 1;
  body = envelope([...TREE, SOCIETY]);
  await cache.getCatalogue();
  await settle();
  assert.equal(stub.calls.length, 3);
  assert.equal((await cache.getCatalogue()).length, 3);
});

// Spec: P2 — cold-start failure returns the built-in seed (four categories, Chinese names,
// Society included) and the page-facing read never throws.
test("P2: cold-start failure returns the built-in four-category seed with Chinese names and never throws", async () => {
  let clock = 2_000_000;
  let mode: "fail" | "ok" = "fail";
  const stub = stubFetch(() => (mode === "fail" ? json({ success: false }, 503) : json(envelope(TREE))));
  const cache = (await cacheFactory())({ fetch: stub.fetch, now: () => clock, log: (line) => logs.push(line) });

  const fallback = await cache.getCatalogue();
  const view = fallback.map((node) => ({
    name: node.name,
    en: node.localized?.["en-GB"]?.name,
    zh: node.localized?.["zh-CN"]?.name,
    children: Array.isArray(node.children) ? node.children.length : -1
  }));
  assert.deepEqual(view, [
    { name: "Science", en: "Science", zh: "科学", children: 0 },
    { name: "Chinese Humanities", en: "Chinese Humanities", zh: "中国人文", children: 0 },
    { name: "European Humanities", en: "European Humanities", zh: "欧洲人文", children: 0 },
    { name: "Society", en: "Society", zh: "社会", children: 0 }
  ]);

  await assert.doesNotReject(cache.getCatalogue(), "a page reading through the cache cannot crash");
  clock += 14_999;
  await cache.getCatalogue();
  assert.equal(stub.calls.length, 1, "a cold-start failure also backs off for 15 s");

  clock += 1;
  mode = "ok";
  await cache.getCatalogue();
  await settle();
  assert.equal(stub.calls.length, 2);
  assert.deepEqual((await cache.getCatalogue()).map(plain), TREE);
  assert.ok(!JSON.stringify(logs).includes(TOKEN), "degradation logs never carry the credential");
});

// Spec: P2/P5 — the cache reports provenance so a caller never over-claims "all categories"
// from the cold-start seed.
test("P2/P5: getSnapshot reports live, last-good and seed provenance across the cache lifecycle", async () => {
  let clock = 7_000_000;
  let mode: "ok" | "fail" = "ok";
  const stub = stubFetch(() => (mode === "fail" ? json({ success: false }, 503) : json(envelope(TREE))));
  const cache = (await cacheFactory())({ fetch: stub.fetch, now: () => clock });
  assert.equal(typeof cache.getSnapshot, "function", "the cache must expose getSnapshot() so a degraded read is distinguishable");
  const snapshot = cache.getSnapshot!;

  const live = await snapshot();
  assert.equal(live.source, "live", "a successful cold read is live Admin data");
  assert.deepEqual(live.tree.map(plain), TREE);

  clock += 60_000;
  mode = "fail";
  const lastGood = await snapshot();
  assert.equal(lastGood.source, "last-good", "a failed refresh keeps real Admin data as last-good");
  assert.deepEqual(lastGood.tree.map(plain), TREE);

  cache.clear();
  const seed = await snapshot();
  assert.equal(seed.source, "seed", "a cold-start failure is the built-in seed, not Admin data");
  assert.equal(seed.tree.length, 4);

  // Admin not configured at all is not a failure: the declared preset list is the directory.
  for (const key of ENV_KEYS) delete process.env[key];
  const unconfigured = (await cacheFactory())({ fetch: stub.fetch, now: () => clock });
  const preset = await unconfigured.getSnapshot!();
  assert.equal(preset.source, "preset", "an unconfigured Admin uses the declared preset list");
  assert.equal(preset.tree.length, 4);
});

// Spec: P1 — env priority ADMIN_PORTAL_BASE_URL/ADMIN_PORTAL_API_TOKEN, else
// KS_TUTOR_BASE_URL/KS_TUTOR_API_KEY; with neither configured no request is made.
test("P1: ADMIN_PORTAL_* is preferred, KS_TUTOR_* is the zero-deploy fallback, neither means no request", async () => {
  const createClient = await clientFactory();

  delete process.env.ADMIN_PORTAL_BASE_URL;
  delete process.env.ADMIN_PORTAL_API_TOKEN;
  process.env.KS_TUTOR_BASE_URL = "http://ks-tutor.local:3100/";
  process.env.KS_TUTOR_API_KEY = "ks-service-token";
  const fallback = stubFetch(() => json(envelope(TREE)));
  await createClient({ fetch: fallback.fetch }).getCatalogue();
  assert.equal(fallback.calls[0].url, "http://ks-tutor.local:3100/api/portal/v1/categories");
  assert.equal(fallback.calls[0].headers.get("x-api-key"), "ks-service-token");

  process.env.ADMIN_PORTAL_BASE_URL = "https://admin.portal.local";
  process.env.ADMIN_PORTAL_API_TOKEN = "portal-api-token";
  const admin = stubFetch(() => json(envelope(TREE)));
  await createClient({ fetch: admin.fetch }).getCatalogue();
  assert.equal(admin.calls[0].url, "https://admin.portal.local/api/portal/v1/categories");
  assert.equal(admin.calls[0].headers.get("x-api-key"), "portal-api-token");

  for (const key of ENV_KEYS) delete process.env[key];
  const none = stubFetch(() => json(envelope(TREE)));
  await assert.rejects(createClient({ fetch: none.fetch }).getCatalogue());
  assert.equal(none.calls.length, 0, "not configured: no request is made");
});

// Spec: P1 — the default deadline is <= 3 s; a hanging Admin is abandoned and the request is
// aborted. P2 — the cache degrades (fallback) instead of holding the page.
// The suite never really waits 3 s: the behaviour run injects a short deadline.
test("P1/P2: the default timeout is <=3 s; a hanging Admin is aborted and the cache degrades quickly", { timeout: 5_000 }, async () => {
  const createClient = await clientFactory();
  const service = await loadService("../../services/adminCatalogue");
  const defaultTimeout = service.ADMIN_CATALOGUE_TIMEOUT_MS;
  assert.equal(typeof defaultTimeout, "number", "services/adminCatalogue.ts must export ADMIN_CATALOGUE_TIMEOUT_MS [P1]");
  assert.ok((defaultTimeout as number) > 0 && (defaultTimeout as number) <= 3_000, `default timeout ${String(defaultTimeout)} ms must be <= 3000`);

  const hanging = () =>
    stubFetch((_call, signal) => new Promise<Response>((_resolve, reject) => {
      const safety = setTimeout(() => reject(new Error("stub never answered")), 400);
      signal?.addEventListener("abort", () => {
        clearTimeout(safety);
        reject(signal.reason);
      });
    }));

  const clientStub = hanging();
  const started = Date.now();
  await assert.rejects(createClient({ fetch: clientStub.fetch, timeouts: { request: 25 } }).getCatalogue());
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `client gave up after ${elapsed} ms (injected 25 ms, stub safety 400 ms)`);
  assert.equal(clientStub.calls.length, 1);
  assert.equal(clientStub.calls[0].signal?.aborted, true, "the request is aborted, not merely ignored");

  const cacheStub = hanging();
  const cache = (await cacheFactory())({ fetch: cacheStub.fetch, now: () => 6_000_000, timeouts: { request: 25 } });
  const cacheStarted = Date.now();
  const fallback = await cache.getCatalogue();
  const cacheElapsed = Date.now() - cacheStarted;
  assert.ok(cacheElapsed < 500, `cache degraded after ${cacheElapsed} ms instead of waiting for the hung request`);
  assert.equal(fallback.length, 4, "a cold timeout falls back to the built-in seed");
  assert.equal(cacheStub.calls.length, 1);
});
