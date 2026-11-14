import type { AdminCatalogueNode, AdminCatalogueLocalized } from "@/contracts/admin-catalogue";

/**
 * Admin category client (design SSOT: P1/C1).
 *
 * Server-only: reads `ADMIN_PORTAL_BASE_URL` / `ADMIN_PORTAL_API_TOKEN` and falls back to the
 * existing `KS_TUTOR_BASE_URL` / `KS_TUTOR_API_KEY` pair (the same Admin origin and AUTH_TOKEN,
 * so deployment needs no new variables). Credentials travel only in the `X-API-Key` header and
 * never reach URLs or log lines.
 *
 * The response is validated strictly: anything that is not the C1 success envelope with a full
 * nested category tree rejects instead of handing partial data to a page.
 */

export const ADMIN_CATALOGUE_TIMEOUT_MS = 3_000;
const CATALOGUE_PATH = "/api/portal/v1/categories";

export type AdminCatalogueClientDeps = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
  timeouts?: { request?: number };
};

export type AdminCatalogueClient = { getCatalogue(): Promise<AdminCatalogueNode[]> };

export type AdminCatalogueErrorCode = "not_configured" | "timeout" | "network" | "http_error" | "invalid_response";

export class AdminCatalogueError extends Error {
  constructor(readonly code: AdminCatalogueErrorCode, readonly status?: number) {
    super(`Admin catalogue request failed (${code}${status === undefined ? "" : `, HTTP ${status}`}).`);
    this.name = "AdminCatalogueError";
  }
}

/** Variable-level priority: ADMIN_PORTAL_* first, KS_TUTOR_* as the zero-deploy fallback. */
function adminCatalogueConfig() {
  const baseUrl = (process.env.ADMIN_PORTAL_BASE_URL?.trim() || process.env.KS_TUTOR_BASE_URL?.trim() || "").replace(/\/+$/, "");
  const apiToken = process.env.ADMIN_PORTAL_API_TOKEN?.trim() || process.env.KS_TUTOR_API_KEY?.trim() || "";
  return { baseUrl, apiToken };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLocalized(value: unknown): AdminCatalogueLocalized | null {
  if (!isRecord(value)) return null;
  const localized: AdminCatalogueLocalized = {};
  for (const [locale, entry] of Object.entries(value)) {
    if (!isRecord(entry)) return null;
    if (entry.name === undefined) continue;
    if (typeof entry.name !== "string") return null;
    localized[locale] = { name: entry.name };
  }
  return localized;
}

function parseNode(value: unknown): AdminCatalogueNode | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) return null;
  const localized = parseLocalized(value.localized);
  if (!localized) return null;
  if (typeof value.sortOrder !== "number" || !Number.isFinite(value.sortOrder)) return null;
  if (!Array.isArray(value.children)) return null;
  const children: AdminCatalogueNode[] = [];
  for (const child of value.children) {
    const parsed = parseNode(child);
    if (!parsed) return null;
    children.push(parsed);
  }
  return { name: value.name, localized, sortOrder: value.sortOrder, children };
}

function parseEnvelope(body: unknown): AdminCatalogueNode[] {
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.data)) throw new AdminCatalogueError("invalid_response");
  const nodes: AdminCatalogueNode[] = [];
  for (const item of body.data) {
    const parsed = parseNode(item);
    if (!parsed) throw new AdminCatalogueError("invalid_response");
    nodes.push(parsed);
  }
  return nodes;
}

export function createAdminCatalogueClient(deps: AdminCatalogueClientDeps = {}): AdminCatalogueClient {
  const fetchImpl = deps.fetch ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const log = deps.log;
  const configuredTimeout = deps.timeouts?.request ?? ADMIN_CATALOGUE_TIMEOUT_MS;

  async function getCatalogue(): Promise<AdminCatalogueNode[]> {
    const { baseUrl, apiToken } = adminCatalogueConfig();
    if (!baseUrl) {
      log?.({ type: "admin-catalogue", event: "not-configured" });
      throw new AdminCatalogueError("not_configured");
    }
    const requestTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : ADMIN_CATALOGUE_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AdminCatalogueError("timeout"));
      }, requestTimeout);
    });
    try {
      const response = await Promise.race([
        fetchImpl(`${baseUrl}${CATALOGUE_PATH}`, {
          method: "GET",
          headers: apiToken ? { "X-API-Key": apiToken } : undefined,
          cache: "no-store",
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (!response.ok) throw new AdminCatalogueError("http_error", response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AdminCatalogueError("invalid_response");
      }
      return parseEnvelope(body);
    } catch (error) {
      const normalised = error instanceof AdminCatalogueError ? error : new AdminCatalogueError("network");
      log?.({ type: "admin-catalogue", event: "request-failed", code: normalised.code, status: normalised.status ?? null });
      throw normalised;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return { getCatalogue };
}
