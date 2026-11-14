import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, stop } from "esbuild";
import { createRequire } from "node:module";
import { buildSubscriptionSelection } from "../../services/subscriptionSelection";
import { PaymentError } from "../../contracts/payment";
import { paymentFailure } from "../../services/paymentHttp";
import type { ProductPlan, ProductSubscription } from "../../services/productStore";
import { verifiedUser, readProductData, writeProductData } from "./helpers/my-learning";

const original = process.cwd(), environment = { ...process.env };
let directory: string, store: typeof import("../../services/productStore");
before(async () => { directory = await mkdtemp(path.join(tmpdir(), "lg-subscription-selection-")); process.chdir(directory); Object.assign(process.env, { STORAGE_BACKEND: "local", APP_ENV: "DEV", PAYMENT_MODE: "demo" }); store = await import("../../services/productStore"); });
after(async () => { await stop(); process.chdir(original); process.env = environment; if (directory && path.dirname(directory) === tmpdir()) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
const blocked = (error: unknown) => error instanceof PaymentError && error.code === "upgrade_unavailable";
async function buy(userId: string, planId: string) { const { quote } = await store.createQuote(userId, planId); return store.completeDemoCheckout(userId, quote.id); }

// Previously issued orders remain reconcilable; new upgrades require Stripe previews.
async function legacyUpgrade(userId: string, subscriptionId: string) {
  const data = await readProductData();
  const source = data.subscriptions.find((item: ProductSubscription) => item.id === subscriptionId)!;
  const quote = { id: `legacy-${userId}`, userId, planId: "everything-pc-6", kind: "upgrade", sourceSubscriptionId: subscriptionId, amountMinor: 6000, creditMinor: 3900, currency: "usd", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
  data.quotes.push(quote); await writeProductData(data); return { quote };
}

test("five states use distinct live paid categories, actual expiry and caller ownership", async () => {
  const data = await store.ensureProductData(), at = Date.parse("2026-10-17T00:00:00Z");
  const make = (index: number, category: string, patch: Partial<ProductSubscription> = {}): ProductSubscription => ({ id: `s${index}`, userId: "owner", planId: `${category}-pc-6`, courseId: "*", scope: category === "everything" ? "everything" : "category", scopeId: category, source: "purchase", state: "active", validFrom: "2026-08-01T00:00:00Z", validTo: "2027-01-31T00:00:00Z", cancelAtPeriodEnd: false, device: "pc", ...patch });
  const categories = [make(1, "Chinese Humanities"), make(2, "Science"), make(3, "European Humanities")];
  // P5: "all categories" is measured against the ACTIVE catalogue, never a count.
  const activeCategoryKeys = categories.map(category => category.scopeId!);
  const build = (subscriptions: ProductSubscription[], owner = "owner") => buildSubscriptionSelection(subscriptions, data.plans, owner, at, { activeCategoryKeys });
  assert.equal(build([]).kind, "none");
  assert.equal(build(categories.slice(0, 1)).kind, "one_category");
  assert.equal(build(categories.slice(0, 2)).kind, "two_categories");
  assert.equal(build(categories).kind, "all_categories");
  const everything = make(4, "everything", { planId: "everything-pc-6" });
  const all = build([...categories, everything]);
  assert.equal(all.kind, "everything"); assert.equal(all.everything?.amountMinor, 9900);
  assert.equal(build(categories, "someone-else").kind, "none");
  for (const patch of [{ source: "trial" }, { state: "expired" }, { validTo: "2020-01-01" }] as Partial<ProductSubscription>[]) assert.equal(build([make(1, "Science", patch)]).kind, "none");
  const cancelled = build([make(1, "Science", { state: "cancel_at_period_end" })]);
  assert.equal(cancelled.kind, "one_category"); assert.equal(cancelled.categorySubscription?.canUpgrade, false);
  assert.equal(build([categories[0], { ...categories[0], id: "same-category-other-term" }]).kind, "one_category");
  assert.equal(build([make(1, "Science", { state: "grace", validTo: "2020-01-01", graceEndsAt: "2026-10-20" })]).kind, "one_category");
  assert.equal(build([{ ...everything, device: "mobile" }]).kind, "everything");
});

test("P2/P5: a cold-start seed catalogue is unknown, so owning the four seed categories is never all_categories", async () => {
  const data = await store.ensureProductData(), at = Date.parse("2026-10-17T00:00:00Z");
  const seedKeys = ["Science", "Chinese Humanities", "European Humanities", "Society"];
  const subscriptions: ProductSubscription[] = seedKeys.map((key, index) => ({ id: `seed-${index}`, userId: "owner", planId: `${key}-pc-6`, courseId: "*", scope: "category", scopeId: key, source: "purchase", state: "active", validFrom: "2026-08-01T00:00:00Z", validTo: "2027-01-31T00:00:00Z", cancelAtPeriodEnd: false, device: "pc" }));
  const build = (source: "live" | "last-good" | "seed") => buildSubscriptionSelection(subscriptions, data.plans, "owner", at, { activeCategoryKeys: seedKeys, activeCatalogueSource: source });

  // The built-in four-category seed is not the live Admin directory: the ACTIVE set is unknown,
  // so a full match against it must not be promoted to "all categories" (P5).
  assert.notEqual(build("seed").kind, "all_categories");
  assert.equal(build("seed").kind, "multiple_categories", "seed ownership is still reported as multiple, just not all");
  // Real Admin data — live or last-good — remains authoritative.
  assert.equal(build("live").kind, "all_categories");
  assert.equal(build("last-good").kind, "all_categories");
});

test("two categories reject upgrade quotes, direct Everything purchases and stale unpaid orders; third stays purchasable", async () => {
  const user = await verifiedUser(store, "selection-two@example.test");
  const fullQuote = await store.createQuote(user.id, "everything-pc-6");
  const first = await buy(user.id, "chinese-humanities-pc-6");
  const upgrade = await legacyUpgrade(user.id, first.subscription.id);
  const pending = await store.createPendingDemoUpgradeOrderFromQuote(user.id, upgrade.quote.id);
  await buy(user.id, "science-pc-12");
  const before = await readProductData();
  assert.equal((await store.getSubscriptionSelection(user.id)).kind, "two_categories");
  assert.ok((await store.listPlansForPurchase(user.id)).filter(p => p.scope === "everything").every(p => p.upgradeUnavailable));
  await assert.rejects(() => store.createUpgradeQuote(user.id, first.subscription.id), blocked);
  await assert.rejects(() => store.createQuote(user.id, "everything-pc-12"), blocked);
  await assert.rejects(() => store.createPendingDemoOrder(user.id, fullQuote.quote.id), blocked);
  await assert.rejects(() => store.createPendingDemoUpgradeOrderFromQuote(user.id, upgrade.quote.id), blocked);
  await assert.rejects(() => store.createPendingStripeUpgradeOrderFromQuote(user.id, upgrade.quote.id), blocked);
  await assert.rejects(() => store.completeDemoOrder(user.id, pending.order.id), blocked);
  const after = await readProductData(); assert.deepEqual(after.orders, before.orders); assert.deepEqual(after.subscriptions, before.subscriptions);
  await buy(user.id, "european-humanities-pc-6");
  // P5: with the four ACTIVE seeded categories, three of four is not "all categories".
  assert.equal((await store.getSubscriptionSelection(user.id)).kind, "multiple_categories");
  await assert.rejects(() => store.createUpgradeQuote(user.id, first.subscription.id), blocked);
});

test("an unlinked or demo Category has no fabricated Stripe quote", async () => {
  const user = await verifiedUser(store, "selection-one@example.test");
  const first = await buy(user.id, "science-pc-6");
  const selection = await store.getSubscriptionSelection(user.id);
  assert.equal(selection.categorySubscription?.canUpgrade, false);
  assert.equal("upgradeEstimate" in selection, false);
  await assert.rejects(() => store.createUpgradeQuote(user.id, first.subscription.id), (error: unknown) => error instanceof PaymentError && error.code === "payment_unavailable");
  const { quote } = await legacyUpgrade(user.id, first.subscription.id);
  const { order } = await store.createPendingDemoUpgradeOrderFromQuote(user.id, quote.id);
  const paid = await store.completeDemoOrder(user.id, order.id);
  assert.equal(paid.subscription.validTo, first.subscription.validTo);
  assert.equal((await store.completeDemoOrder(user.id, order.id)).order.id, order.id);
});

test("quote API derives user from Session and localises the multi-category rejection", async () => {
  const user = await verifiedUser(store, "selection-api@example.test");
  const first = await buy(user.id, "science-pc-6"); await buy(user.id, "chinese-humanities-pc-6");
  const state = { user: null as { id: string; locale: string } | null, createQuote: store.createQuote, createUpgradeQuote: store.createUpgradeQuote, getQuoteForUser: store.getQuoteForUser, paymentFailure };
  (globalThis as any).selectionApi = state;
  try {
    const bundle = await build({ entryPoints: [path.join(original, "app/api/subscription/quote/route.ts")], bundle: true, write: false, platform: "node", format: "cjs", external: ["next/server"], plugins: [{ name: "session", setup(b) {
      b.onResolve({ filter: /services\/(productStore|productAuth|paymentHttp)$/ }, args => ({ path: args.path, namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path.endsWith("productAuth") ? "export async function currentProductUser(){return globalThis.selectionApi.user}" : args.path.endsWith("paymentHttp") ? "export const paymentFailure=(...args)=>globalThis.selectionApi.paymentFailure(...args)" : "export const createQuote=(...args)=>globalThis.selectionApi.createQuote(...args),createUpgradeQuote=(...args)=>globalThis.selectionApi.createUpgradeQuote(...args),getQuoteForUser=(...args)=>globalThis.selectionApi.getQuoteForUser(...args)" }));
    } }] });
    const routeModule = { exports: {} as { POST: (request: Request) => Promise<Response> } }; new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
    const invoke = () => routeModule.exports.POST(new Request("http://localhost/api/subscription/quote", { method: "POST", body: JSON.stringify({ kind: "upgrade", subscriptionId: first.subscription.id, userId: "forged" }) }));
    assert.equal((await invoke()).status, 401);
    for (const locale of ["en-GB", "zh-CN"]) { state.user = { id: user.id, locale }; const response = await invoke(); assert.equal(response.status, 400); const body = await response.json(); assert.equal(body.code, "upgrade_unavailable"); assert.ok(body.message.includes(locale === "en-GB" ? "one Category" : "一个 Category")); }
  } finally { delete (globalThis as any).selectionApi; }
});

test("subscription route uses Session ownership and normalises catalogue categories before rendering", async () => {
  const state = { user: { id: "owner", nickname: "Current User" } as { id: string; nickname: string } | null, calls: [] as (string | undefined)[], fail: false };
  // C1/P5: the page consumes the Admin catalogue's four ACTIVE categories
  // (stable name + localized), not the retired Portal CMS three-category list.
  const catalogue = [
    { name: "Science", localized: { "en-GB": { name: "Science" }, "zh-CN": { name: "科学" } }, sortOrder: 0, children: [] },
    { name: "Chinese Humanities", localized: { "en-GB": { name: "Chinese Humanities" }, "zh-CN": { name: "中国人文" } }, sortOrder: 1, children: [] },
    { name: "European Humanities", localized: { "en-GB": { name: "European Humanities" }, "zh-CN": { name: "欧洲人文" } }, sortOrder: 2, children: [] },
    { name: "Society", localized: { "en-GB": { name: "Society" }, "zh-CN": { name: "社会" } }, sortOrder: 3, children: [] }
  ];
  (globalThis as any).selectionRoute = { state, catalogue, selection: buildSubscriptionSelection([], [], "owner") };
  try {
    const bundle = await build({ entryPoints: [path.join(original, "app/[locale]/subscription/page.tsx")], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react/jsx-runtime"], plugins: [{ name: "session", setup(b) {
      b.onResolve({ filter: /services\/(productAuth|productStore|adminCatalogueCache)$|components\/portal\/(SubscriptionSelection|PurchasePanel|PortalHeader|PortalFooter)$/ }, args => ({ path: args.path, namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path.endsWith("productAuth") ? "export async function currentProductUser(){return globalThis.selectionRoute.state.user}" : args.path.endsWith("adminCatalogueCache") ? "export async function getAdminCatalogue(){return globalThis.selectionRoute.catalogue}" : args.path.endsWith("productStore") ? `export async function getPortalContent(){return {categories:[]}};export async function listPlansForPurchase(){return []};export async function getProductCourse(){return null};export async function listPublishedCourses(){return [{categoryKey:'Chinese Humanities',title:'Actual course'}]};export async function getSubscriptionSelection(user){globalThis.selectionRoute.state.calls.push(user);if(globalThis.selectionRoute.state.fail)throw new Error('selection-store-unavailable');return globalThis.selectionRoute.selection}` : "export const SubscriptionSelection=()=>null,PurchasePanel=()=>null,PortalHeader=()=>null,PortalFooter=()=>null" }));
    } }] });
    const routeModule = { exports: {} as { default: (props: any) => Promise<any> } }; new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), routeModule, routeModule.exports);
    const invoke = (locale = "en-GB") => routeModule.exports.default({ params: Promise.resolve({ locale }), searchParams: Promise.resolve({ upgradeFrom: "forged-subscription" }) });
    const expectedCategories = catalogue.map(node => ({ id: node.name, labels: { "en-GB": node.localized["en-GB"].name, "zh-CN": node.localized["zh-CN"].name } }));
    for (const locale of ["en-GB", "zh-CN"]) { const page = await invoke(locale); const props = page.props.children[1].props.children[0].props; assert.equal(props.selection.kind, "none"); assert.equal(props.categories.length, 4, "the subscription page passes the four ACTIVE Admin categories"); assert.deepEqual(props.categories, expectedCategories); assert.ok(props.categories.some((category: { id: string }) => category.id === "Society"), "Society is purchasable surface on the subscription page"); assert.deepEqual(props.courseTitles, [{ category: "Chinese Humanities", title: "Actual course" }]); }
    assert.deepEqual(state.calls, ["owner", "owner"]);
    state.user = null; await invoke(); assert.equal(state.calls.at(-1), undefined);
    state.fail = true; await assert.rejects(invoke(), /selection-store-unavailable/);
  } finally { delete (globalThis as any).selectionRoute; }
});
