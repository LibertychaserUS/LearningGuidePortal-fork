import type { ProductLesson, ProductPlan } from "@/services/productStore";

/** PRD 12.5.1: display only the measured video duration; never fall back to the lesson's configured minutes. */
export function courseLessonDuration(lesson?: Pick<ProductLesson, "durationMinutes" | "videoDurationSeconds">) {
  const seconds = lesson?.videoDurationSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

/** Keep course totals in whole-hour and remaining-minute form for the course detail UI. */
export function courseDurationParts(totalMinutes: number) {
  const minutes = Number.isFinite(totalMinutes) ? Math.max(0, Math.round(totalMinutes)) : 0;
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

export function courseCategoryPlan(plans: ProductPlan[], category: string) {
  return plans.find((plan) => plan.scope === "category" && plan.device === "pc" &&
    plan.termMonths === 6 && plan.available !== false && (plan.scopeId || plan.category) === category);
}
