import type { AdminCatalogueSource } from "./adminCatalogueCache";
import type { AdminCatalogueNode } from "@/contracts/admin-catalogue";
import type { SubscriptionSelectionState } from "@/contracts/subscription-selection";
import { normaliseCategoryKey } from "@/lib/coursePage";
import type { ProductPlan, ProductSubscription } from "./productStore";
import { withPlanAiPoints } from "./planAiPoints";

export function livePaidSubscriptions(subscriptions: ProductSubscription[], userId: string, at = Date.now()) {
  return subscriptions.filter(item => item.userId === userId && item.source === "purchase"
    && ["active", "cancel_at_period_end", "grace"].includes(item.state)
    && Date.parse(item.state === "grace" ? item.graceEndsAt || item.validTo : item.validTo) > at);
}

export function subscriptionCoverage(subscriptions: ProductSubscription[], plans: ProductPlan[], userId: string, at = Date.now()) {
  const live = livePaidSubscriptions(subscriptions, userId, at);
  const scope = (item: ProductSubscription) => item.scope || plans.find(plan => plan.id === item.planId)?.scope || (item.courseId === "*" ? "everything" : "course");
  const categories = live.filter(item => scope(item) === "category");
  // P5: a category scope is identified by its stable key (`scopeId`), never by a display label.
  // One canonical key is owned once even if legacy rows differ only by case or spacing.
  const owned = new Map<string, string>();
  for (const item of categories) {
    const scopeId = item.scopeId || plans.find(plan => plan.id === item.planId)?.scopeId;
    const key = normaliseCategoryKey(scopeId);
    if (key && !owned.has(key)) owned.set(key, scopeId as string);
  }
  return { everything: live.find(item => scope(item) === "everything"), categories, categoryIds: [...owned.values()] };
}

/** Every ACTIVE category key in the Admin catalogue tree (P5: "all categories" = all of these). */
export function activeCatalogueKeys(catalogue: readonly AdminCatalogueNode[]): string[] {
  const keys: string[] = [];
  const visit = (nodes: readonly AdminCatalogueNode[]) => {
    for (const node of nodes) {
      keys.push(node.name);
      visit(node.children);
    }
  };
  visit(catalogue);
  return keys;
}

export function buildSubscriptionSelection(
  subscriptions: ProductSubscription[],
  plans: ProductPlan[],
  userId: string,
  at = Date.now(),
  options: { activeCategoryKeys?: readonly string[]; activeCatalogueSource?: AdminCatalogueSource } = {},
): SubscriptionSelectionState {
  plans = withPlanAiPoints(plans);
  const coverage = subscriptionCoverage(subscriptions, plans, userId, at);
  const source = coverage.categoryIds.length === 1 ? coverage.categories.find(item => item.state === "active" && (item.device || plans.find(plan => plan.id === item.planId)?.device || "pc") === "pc") || coverage.categories[0] : null;
  const sourcePlan = source && plans.find(plan => plan.id === source.planId);
  const everythingPlan = coverage.everything && plans.find(plan => plan.id === coverage.everything!.planId);
  const ownedKeys = new Set(coverage.categoryIds.map(normaliseCategoryKey).filter((key): key is string => Boolean(key)));
  // P5: "all categories" means every ACTIVE catalogue category is covered — never a count >= 3.
  // P2: when Admin was configured but unreachable at cold start, the tree is the seed and the
  // ACTIVE set is unknown, so it must never be claimed as "all". `last-good` is real Admin data
  // and `preset` is the declared list when Admin is not configured at all — both stay authoritative.
  const directoryKnown = options.activeCatalogueSource !== "seed";
  const activeKeys = (options.activeCategoryKeys || []).map(normaliseCategoryKey).filter((key): key is string => Boolean(key));
  const allCategories = directoryKnown && activeKeys.length > 0 && activeKeys.every(key => ownedKeys.has(key));
  return {
    kind: coverage.everything ? "everything" : allCategories ? "all_categories" : coverage.categoryIds.length === 1 ? "one_category" : coverage.categoryIds.length === 2 ? "two_categories" : coverage.categoryIds.length > 2 ? "multiple_categories" : "none",
    ownedCategoryIds: coverage.categoryIds,
    categoryRenewals: coverage.categories.every(item => item.state === "active" && !item.cancelAtPeriodEnd),
    categorySubscription: source ? { id: source.id, validTo: source.validTo, remainingDays: Math.max(0, Math.ceil((Date.parse(source.validTo) - at) / 86_400_000)),
      canUpgrade: !coverage.everything && source.state === "active" && !source.cancelAtPeriodEnd && Boolean(source.stripeSubscriptionId && source.stripeCustomerId && sourcePlan) && (source.device || sourcePlan?.device) === "pc", aiPoints: sourcePlan?.aiPoints || 0, termMonths: sourcePlan?.termMonths || 6 } : null,
    everything: coverage.everything ? { validTo: coverage.everything.validTo, renewal: coverage.everything.state === "active" && !coverage.everything.cancelAtPeriodEnd,
      paymentPending: coverage.everything.state === "grace", amountMinor: everythingPlan?.amountMinor ?? null, currency: everythingPlan?.currency || "usd" } : null,
  };
}
