import type { AdminCatalogueLocalized, AdminCatalogueNode } from "@/contracts/admin-catalogue";
import type { Locale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

/**
 * P4/P5 — category display names come from the Admin catalogue `localized`
 * template only. There is no hard-coded category table in code: callers that
 * have the catalogue pass its localized template; the remaining legacy surface
 * (subscription records) falls back to the UI message dictionary, and a stable
 * key with no translation is rendered as-is (trimmed).
 */

/** A subscription category card: stable key (`AdminCatalogueEntry.name`) plus per-locale display names. */
export type SubscriptionCategory = { id: string; labels: Record<Locale, string> };

function labelsFor(node: AdminCatalogueNode): Record<Locale, string> {
  const fallback = node.name.trim() || node.name;
  const english = node.localized["en-GB"]?.name?.trim() || fallback;
  return {
    "en-GB": english,
    "zh-CN": node.localized["zh-CN"]?.name?.trim() || english
  };
}

/**
 * The subscription page's category cards are the top-level ACTIVE Admin
 * catalogue categories (C1 tree roots), keyed by the stable `name` so the
 * page's owned/remaining calculation uses the same keys the backend compares
 * against `activeCategoryKeys` (P5).
 */
export function subscriptionCategories(catalogue: readonly AdminCatalogueNode[]): SubscriptionCategory[] {
  return catalogue.map((node) => ({ id: node.name, labels: labelsFor(node) }));
}

/**
 * Localized label for a category stable key; unknown keys are shown as-is.
 *
 * Preference order: the Admin catalogue `localized` template (the single
 * source of display names), then the UI message dictionary — matched by the
 * catalogue's English display name, never by a bespoke category-name table —
 * and finally the stable key itself.
 */
export function subscriptionCategoryLabel(name: string, locale: Locale, localized?: AdminCatalogueLocalized): string {
  const key = name.trim();
  if (!key) return name;
  const fromCatalogue = localized?.[locale]?.name?.trim() || localized?.["en-GB"]?.name?.trim();
  if (fromCatalogue) return fromCatalogue;
  const target = key.toLocaleLowerCase();
  const english = getMessages("en-GB").overviewV1.categories;
  for (const [entry, label] of Object.entries(english)) {
    if (label.toLocaleLowerCase() === target) return getMessages(locale).overviewV1.categories[entry as keyof typeof english];
  }
  return key;
}
