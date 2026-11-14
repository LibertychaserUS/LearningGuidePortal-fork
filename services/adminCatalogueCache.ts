import { AdminCatalogueError, createAdminCatalogueClient, type AdminCatalogueClientDeps } from "./adminCatalogue";
import type { AdminCatalogue, AdminCatalogueNode } from "@/contracts/admin-catalogue";

/**
 * Admin category client and in-memory cache (design SSOT: P1/P2).
 *
 * Portal consumes Admin's `GET /api/portal/v1/categories` only. This module never lets a page
 * crash because Admin is slow or unavailable: a fresh cache serves reads for 60 s, concurrent
 * cold readers share one request, a failed refresh keeps the last good catalogue and suppresses
 * retries for 15 s, and a cold-start failure degrades to the built-in seed of the four preset
 * categories. The seed is reported with its provenance: `preset` means no Admin is configured at
 * all (the deployment runs on the declared preset list), while `seed` means Admin was configured
 * but was unreachable at cold start — in that state the live directory is unknown.
 */

export const ADMIN_CATALOGUE_TTL_MS = 60_000;
export const ADMIN_CATALOGUE_RETRY_MS = 15_000;

const seedNode = (name: string, en: string, zh: string, sortOrder: number): AdminCatalogueNode => ({
  name,
  localized: { "en-GB": { name: en }, "zh-CN": { name: zh } },
  sortOrder,
  children: [],
});

/** Cold-start fallback (P2): the four preset categories, including their Chinese names. */
export const ADMIN_CATALOGUE_SEED: AdminCatalogue = [
  seedNode("Science", "Science", "科学", 0),
  seedNode("Chinese Humanities", "Chinese Humanities", "中国人文", 1),
  seedNode("European Humanities", "European Humanities", "欧洲人文", 2),
  seedNode("Society", "Society", "社会", 3),
];

function cloneCatalogue(catalogue: AdminCatalogue): AdminCatalogue {
  return catalogue.map((node) => ({
    ...node,
    localized: Object.fromEntries(Object.entries(node.localized).map(([locale, value]) => [locale, { ...value }])),
    children: cloneCatalogue(node.children),
  }));
}

/**
 * Where a catalogue read came from.
 * - `live` / `last-good`: real Admin directory data (last-good is stale but authoritative).
 * - `preset`: Admin is not configured, so the declared preset list is the category directory.
 * - `seed`: Admin is configured but was unreachable at cold start — the ACTIVE directory is
 *   unknown, so callers must not treat the fallback as a real list (e.g. never "all categories").
 */
export type AdminCatalogueSource = "live" | "last-good" | "preset" | "seed";

export type AdminCatalogueSnapshot = {
  tree: AdminCatalogueNode[];
  source: AdminCatalogueSource;
};

export type AdminCatalogueCache = {
  /** Never rejects: fresh cache -> last good -> built-in seed. */
  getCatalogue(): Promise<AdminCatalogueNode[]>;
  /** Same lookup as `getCatalogue`, also reporting whether the tree is authoritative. */
  getSnapshot(): Promise<AdminCatalogueSnapshot>;
  clear(): void;
};

export function createAdminCatalogueCache(deps: AdminCatalogueClientDeps = {}): AdminCatalogueCache {
  const client = createAdminCatalogueClient(deps);
  const now = deps.now ?? (() => Date.now());
  const log = deps.log;
  let fresh: { at: number; tree: AdminCatalogueNode[] } | null = null;
  let lastGood: AdminCatalogueNode[] | null = null;
  let failedAt: number | null = null;
  let inflight: Promise<AdminCatalogueSnapshot> | null = null;
  // Which fallback the last failure produced: "preset" when Admin is not configured at all,
  // "seed" when Admin is configured but unreachable (the ACTIVE directory is then unknown).
  let coldSource: Extract<AdminCatalogueSource, "preset" | "seed"> = "seed";

  const fallback = (): AdminCatalogueSnapshot =>
    lastGood ? { tree: lastGood, source: "last-good" } : { tree: cloneCatalogue(ADMIN_CATALOGUE_SEED), source: coldSource };

  async function refresh(): Promise<AdminCatalogueSnapshot> {
    try {
      const tree = await client.getCatalogue();
      fresh = { at: now(), tree };
      lastGood = tree;
      failedAt = null;
      return { tree, source: "live" };
    } catch (error) {
      failedAt = now();
      const code = error instanceof AdminCatalogueError ? error.code : "unknown";
      coldSource = code === "not_configured" ? "preset" : "seed";
      log?.({
        type: "admin-catalogue",
        event: "degraded",
        code,
        fallback: lastGood ? "last-good" : coldSource,
      });
      return fallback();
    }
  }

  async function getSnapshot(): Promise<AdminCatalogueSnapshot> {
    const time = now();
    if (fresh && time - fresh.at < ADMIN_CATALOGUE_TTL_MS) return { tree: fresh.tree, source: "live" };
    if (failedAt !== null && time - failedAt < ADMIN_CATALOGUE_RETRY_MS) return fallback();
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    getSnapshot,
    async getCatalogue() {
      return (await getSnapshot()).tree;
    },
    clear() {
      fresh = null;
      lastGood = null;
      failedAt = null;
      inflight = null;
    },
  };
}

let defaultCache: AdminCatalogueCache | null = null;

/** The process-wide cache every Portal surface reads through. */
export function getAdminCatalogue(): Promise<AdminCatalogueNode[]> {
  return getAdminCatalogueSnapshot().then((snapshot) => snapshot.tree);
}

/**
 * Catalogue lookup that also reports provenance. Callers that must not over-claim
 * (e.g. "all categories") use `source === "seed"` to treat the directory as unknown.
 */
export function getAdminCatalogueSnapshot(): Promise<AdminCatalogueSnapshot> {
  defaultCache ||= createAdminCatalogueCache();
  return defaultCache.getSnapshot();
}

export function clearAdminCatalogueCache() {
  defaultCache?.clear();
}
