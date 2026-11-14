import assert from "node:assert/strict";
import { test } from "node:test";
import { withPlanAiPoints } from "../../services/planAiPoints";
import type { AiPointsPlan } from "../../contracts/plan-ai-points";
import { isolate } from "../io/harness";
import { readProductData, verifiedUser, writeProductData } from "./helpers/my-learning";

// P5 (Course_Category_Single_Source_Design.md): the AI allowance shown for a plan is the plan
// record's `aiPoints`; Portal no longer substitutes a hard-coded per-category tier table.

test("PC subscription offers keep the plan record's allowance without mutating the records", () => {
  const base: AiPointsPlan = { courseId: "*", scope: "category", scopeId: "Science", device: "pc", termMonths: 6, aiPoints: 731 };
  const plans = [base, { ...base, termMonths: 12 as const, aiPoints: 731 }, { ...base, device: "mobile" as const, aiPoints: 0 }, { ...base, device: "mobile" as const, termMonths: 12 as const, aiPoints: 99 }, { ...base, scopeId: "Art", termMonths: 12 as const, aiPoints: 600 }, { ...base, scope: "everything" as const, scopeId: "*", aiPoints: 10000 }, { ...base, scope: "everything" as const, scopeId: "*", termMonths: 12 as const, aiPoints: 10000 }];
  const before = structuredClone(plans), result = withPlanAiPoints(plans);
  assert.deepEqual(result.map(plan => plan.aiPoints), [731,731,0,99,600,10000,10000], "P5: plan data is the allowance");
  assert.deepEqual(plans, before);
  assert.deepEqual(withPlanAiPoints(result), result, "repeated calculation retains the same allowance");
});

test("course-specific offers also read their plan record", () => {
  const base: AiPointsPlan = { courseId: "course", scope: "course", scopeId: "course", device: "pc", termMonths: 6, aiPoints: 731 };
  assert.deepEqual(withPlanAiPoints([base, { ...base, termMonths: 12 }, { ...base, scopeId: "other", termMonths: 12, aiPoints: 600 }]).map(plan => plan.aiPoints), [731,731,600]);
});

test("catalogue/API, new quotes and upgrade source agree while existing quote snapshots retain their allowance", async () => {
  const { restore } = await isolate("lg-plan-ai-points-");
  try {
    const store = await import("../../services/productStore");
    await store.ensureProductData();const data = await readProductData();
    for (const plan of data.plans) if (plan.device === "pc") plan.aiPoints = plan.termMonths === 6 ? plan.scope === "everything" ? 1234 : 456 : 999;
    await writeProductData(data);
    const catalogueBefore = structuredClone(data.plans);
    const plans = await store.listPlans();
    for (const plan of plans.filter(plan => plan.device === "pc" && plan.scope !== "course")) {
      assert.equal(plan.aiPoints, plan.termMonths === 6 ? (plan.scope === "everything" ? 1234 : 456) : 999, "P5: the API reports the stored plan allowance");
    }
    assert.deepEqual((await readProductData()).plans,catalogueBefore,"reading offers does not rewrite persisted plans");
    const { GET } = await import("../../app/api/portal/plans/route");
    const response = await GET(new Request("http://localhost/api/portal/plans"));
    assert.equal(response.status,200);
    const body = await response.json();assert.equal(body.plans.find((plan: { id: string; aiPoints: number }) => plan.id === "everything-pc-12").aiPoints,999);
    const user = await verifiedUser(store,"annual-points@example.test");
    for (const [planId, points] of [["everything-pc-6",1234],["everything-pc-12",999],["european-humanities-pc-6",456]] as const) {
      const result = await store.createQuote(user.id, planId);
      assert.equal(result.plan.aiPoints,points);assert.equal(result.quote.planSnapshot?.aiPoints,points);
    }
    const quote = await store.createQuote(user.id,"european-humanities-pc-12");
    assert.equal(quote.plan.aiPoints,999);assert.equal(quote.quote.planSnapshot?.aiPoints,999);
    assert.equal((await store.getQuoteForUser(user.id,quote.quote.id))?.plan.aiPoints,999);
    await store.completeDemoCheckout(user.id,quote.quote.id);
    assert.equal((await store.getSubscriptionSelection(user.id)).categorySubscription?.aiPoints,999,"P5: the subscription allowance is the plan's aiPoints");
    const updated = await readProductData();
    updated.quotes.find((item: { id: string })=>item.id===quote.quote.id).planSnapshot.aiPoints=912;
    updated.plans.find((plan: { id: string; aiPoints: number })=>plan.id==="european-humanities-pc-6").aiPoints=1000;
    await writeProductData(updated);
    assert.equal((await store.listPlans()).find(plan=>plan.id==="european-humanities-pc-12")?.aiPoints,999);
    assert.equal((await store.getQuoteForUser(user.id,quote.quote.id))?.plan.aiPoints,912,"existing quote snapshots retain their promised allowance");
  } finally { await restore(); }
});
