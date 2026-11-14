import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultPortalContent } from "../../lib/portalContent";
import { writeProductData } from "./helpers/my-learning";

// S8 — Portal CMS and legacy backoffice write guards (black-box TDD spec).
//
// Design SSOT: /Users/nihao/AI infra/LearningGuideAdmin/docs/Course_Category_Single_Source_Design.md
//   P6  PUT /api/backoffice/portal rejects payloads that change categories with
//       422 CATEGORIES_MANAGED_IN_ADMIN and stores nothing; the translation endpoint
//       rejects category payloads the same way. Category display names are Admin-owned.
//   P7  POST/PATCH /api/backoffice/courses/catalogue* answer 410 CATALOGUE_MANAGED_IN_ADMIN;
//       reads stay available during the read-only transition.
//
// Only existing public entries are exercised: the Next route handlers imported directly and
// observed through HTTP status/body plus the productStore read API.

const cwd = process.cwd();
const environment = { ...process.env };
const host = "localhost:3097";
let directory: string;
let store: typeof import("../../services/productStore");
let cms: typeof import("../../app/api/backoffice/portal/route");
let translate: typeof import("../../app/api/backoffice/portal/translate/route");
let catalogue: typeof import("../../app/api/backoffice/courses/catalogue/route");
let catalogueEntry: typeof import("../../app/api/backoffice/courses/catalogue/[entryId]/route");
let operator: { id: string };
let token: string;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lg-category-cms-guard-"));
  process.chdir(directory);
  Object.assign(process.env, { STORAGE_BACKEND: "local", APP_ENV: "DEV", ADMIN_HOSTS: "localhost", BACKOFFICE_OPERATOR_EMAIL: "operator@category-guard.test" });
  delete process.env.OPENROUTER_API_KEY;
  store = await import("../../services/productStore");
  cms = await import("../../app/api/backoffice/portal/route");
  translate = await import("../../app/api/backoffice/portal/translate/route");
  catalogue = await import("../../app/api/backoffice/courses/catalogue/route");
  catalogueEntry = await import("../../app/api/backoffice/courses/catalogue/[entryId]/route");
  operator = await store.registerUser({ email: "operator@category-guard.test", password: "password1", role: "operator" });
  await store.verifyEmailToken(await store.issueEmailVerificationToken(operator.id));
  token = (await store.createSession(operator.id)).token;
});

after(async () => {
  process.chdir(cwd);
  process.env = environment;
  if (directory && path.dirname(directory) === tmpdir()) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function request(method: string, body?: BodyInit, options: { pathname?: string } = {}) {
  return new Request(`http://${host}${options.pathname || "/api/backoffice/portal"}`, {
    method,
    headers: { host, origin: `http://${host}`, cookie: `learning_guide_admin_session=${token}` },
    ...(body === undefined ? {} : { body }),
  });
}

function containsCode(body: unknown, code: string) {
  return JSON.stringify(body).includes(code);
}

// P6 — only category changes are rejected: a save that leaves categories untouched still works,
// and categories stored by the CMS are not rewritten by it.
test("P6: a save that leaves categories untouched still succeeds (only category changes are rejected)", async () => {
  const before = await store.getPortalContent();
  const payload = structuredClone(defaultPortalContent);
  payload.banners["en-GB"][0].title = "CMS heading saved without category edits";
  const response = await cms.PUT(request("PUT", JSON.stringify(payload)));
  assert.equal(response.status, 200, "P6: non-category CMS edits remain writable");
  const after = await store.getPortalContent();
  assert.equal(after.banners["en-GB"][0].title, payload.banners["en-GB"][0].title);
  assert.deepEqual(after.categories, before.categories, "P6: the CMS save does not rewrite categories");
});

// P6 — a category change (label rename or removal) is rejected with 422
// CATEGORIES_MANAGED_IN_ADMIN and the stored CMS content stays byte-for-byte the same.
test("P6: PUT /api/backoffice/portal rejects category changes with 422 CATEGORIES_MANAGED_IN_ADMIN and stores nothing", async () => {
  const before = await store.getPortalContent();
  const renamed = structuredClone(defaultPortalContent) as any;
  renamed.categories[0].labels["en-GB"] = "Renamed inside the Portal CMS";
  const removed = structuredClone(defaultPortalContent) as any;
  removed.categories = removed.categories.slice(0, 2);

  for (const [label, payload] of [["label rename", renamed], ["category removal", removed]] as const) {
    const response = await cms.PUT(request("PUT", JSON.stringify(payload)));
    assert.equal(response.status, 422, `P6: a ${label} in the portal payload must be rejected with 422`);
    assert.ok(
      containsCode(await response.json(), "CATEGORIES_MANAGED_IN_ADMIN"),
      `P6: the ${label} rejection carries the CATEGORIES_MANAGED_IN_ADMIN error code`,
    );
    assert.deepEqual(await store.getPortalContent(), before, `P6: a rejected ${label} save changes nothing`);
  }
});

// P6 — the translation endpoint rejects payloads that carry categories: display names come from
// the Admin localized template, never from CMS translation.
test("P6: the translation endpoint rejects category payloads with 422 CATEGORIES_MANAGED_IN_ADMIN", async () => {
  const payload = structuredClone(defaultPortalContent) as any;
  payload.categories[0].labels["en-GB"] = "Translation must not own this";
  const response = await translate.POST(
    request("POST", JSON.stringify({ source: "en-GB", content: payload }), { pathname: "/api/backoffice/portal/translate" }),
  );
  assert.equal(response.status, 422, "P6: category payloads must be rejected before any translation runs");
  assert.ok(
    containsCode(await response.json(), "CATEGORIES_MANAGED_IN_ADMIN"),
    "P6: the translation rejection carries the CATEGORIES_MANAGED_IN_ADMIN error code",
  );
});

// P7 — the legacy catalogue write endpoints are closed: POST and PATCH answer 410
// CATALOGUE_MANAGED_IN_ADMIN and leave the stored catalogue untouched.
test("P7: legacy catalogue POST and PATCH answer 410 CATALOGUE_MANAGED_IN_ADMIN and do not write", async () => {
  const data = await store.ensureProductData() as any;
  const entry = {
    id: "cat-society",
    name: "Society",
    description: "",
    parentId: null,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.catalogue = [...(data.catalogue || []), entry];
  await writeProductData(data);
  const before = await store.getCourseCatalogue(operator.id);

  const created = await catalogue.POST(
    request("POST", JSON.stringify({ name: "A category created from the Portal" }), { pathname: "/api/backoffice/courses/catalogue" }),
  );
  assert.equal(created.status, 410, "P7: POST /api/backoffice/courses/catalogue is managed in Admin");
  assert.ok(containsCode(await created.json(), "CATALOGUE_MANAGED_IN_ADMIN"), "P7: POST carries CATALOGUE_MANAGED_IN_ADMIN");

  const patched = await catalogueEntry.PATCH(
    request("PATCH", JSON.stringify({ name: "Society Renamed", expectedUpdatedAt: entry.updatedAt }), {
      pathname: "/api/backoffice/courses/catalogue/cat-society",
    }),
    { params: Promise.resolve({ entryId: "cat-society" }) },
  );
  assert.equal(patched.status, 410, "P7: PATCH /api/backoffice/courses/catalogue/[entryId] is managed in Admin");
  assert.ok(containsCode(await patched.json(), "CATALOGUE_MANAGED_IN_ADMIN"), "P7: PATCH carries CATALOGUE_MANAGED_IN_ADMIN");

  assert.deepEqual(await store.getCourseCatalogue(operator.id), before, "P7: rejected legacy writes leave the catalogue untouched");
});

// P7 — reads stay available during the read-only transition.
test("P7: GET /api/backoffice/courses/catalogue stays readable", async () => {
  const response = await catalogue.GET(request("GET", undefined, { pathname: "/api/backoffice/courses/catalogue" }));
  assert.equal(response.status, 200, "P7: catalogue reads remain available while writes are closed");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.entries), "P7: the read still returns the catalogue entries");
});
