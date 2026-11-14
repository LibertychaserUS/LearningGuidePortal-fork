import type { AiPointsPlan } from "@/contracts/plan-ai-points";

/**
 * P5 — the AI allowance is plan data.
 *
 * Portal no longer derives a category allowance from a hard-coded tier table or from how many
 * categories a learner owns: the plan record's `aiPoints` is what the learner is promised.
 * Only a missing/invalid value is normalised to zero so callers always render a number.
 */
export function withPlanAiPoints<T extends AiPointsPlan>(plans: readonly T[]): T[] {
  return plans.map(plan =>
    Number.isSafeInteger(plan.aiPoints) && (plan.aiPoints as number) >= 0
      ? plan
      : { ...plan, aiPoints: 0 });
}
