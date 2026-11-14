/**
 * Admin catalogue contract (design SSOT: Course_Category_Single_Source_Design.md, C1/P1/P2).
 *
 * `GET /api/portal/v1/categories` returns `{ success:true, data:[node], error:null, message }`
 * where a node is `{ name, localized, sortOrder, children:[node] }`. The Admin catalogue is the
 * single source of category display names; Portal never invents a category.
 *
 * `name` is the stable key; `localized` carries the display name per language. The contract
 * deliberately exposes no Admin UUIDs: Portal may not depend on environment-local ids.
 */
export type AdminCatalogueLocalized = Record<string, { name: string }>;

export type AdminCatalogueNode = {
  /** Stable category key (Admin `CourseCatalogueEntry.name`). */
  name: string;
  /** Display-name template `{ lang: { name } }`; en-GB is the fallback language. */
  localized: AdminCatalogueLocalized;
  sortOrder: number;
  children: AdminCatalogueNode[];
};

export type AdminCatalogue = AdminCatalogueNode[];
