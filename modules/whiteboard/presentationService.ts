import { displayName, parseImportUrl, PresentationError, PRESENTATION_LIMITS, sniffUpload, type Presentation, type PresentationErrorCode, type PresentationSource } from "./presentation";
import { WhiteboardError } from "./domain";
import type { PresentationRef } from "./stage";
import type { WhiteboardRoster } from "./service";
import type { WhiteboardMessage } from "./wire";

// Ports. Production keeps the records in PostgreSQL (unique key on session +
// content key) and the files in S3 under the session; the prototype ships an
// in-memory store.
export interface PresentationStore {
  // Creates the record unless one with the same session and content key
  // exists; then that one comes back with created = false.
  create(record: Presentation): Promise<{ record: Presentation; created: boolean }>;
  update(id: string, patch: Partial<Pick<Presentation, "status" | "error" | "pageCount">>): Promise<Presentation>;
  get(sessionId: string, id: string): Promise<Presentation | null>;
  list(sessionId: string): Promise<Presentation[]>;
  remove(sessionId: string, id: string): Promise<void>;
  putFile(id: string, kind: "original" | "pdf", bytes: Uint8Array): Promise<void>;
  getFile(id: string, kind: "original" | "pdf"): Promise<Uint8Array | null>;
}

export type ConversionInput =
  | { source: "office" | "image"; extension: string; bytes: Uint8Array }
  | { source: "web"; url: URL };

// Turns an upload into one PDF. Runs LibreOffice (Office documents, images)
// or a headless browser (web pages); see converters.ts.
export type PresentationConverter = (input: ConversionInput) => Promise<Uint8Array>;

// Reads the page count of a PDF; throws PresentationError("encrypted" |
// "conversion_failed") when it cannot.
export type PdfInspector = (pdf: Uint8Array) => Promise<{ pageCount: number }>;

// The addresses a host name resolves to, for the web import check.
export type HostResolver = (hostname: string) => Promise<string[]>;

export type PresentationBroadcaster = (input: { sessionId: string; message: WhiteboardMessage; destinationIdentities?: string[] }) => Promise<void>;

async function sha256(bytes: Uint8Array | string) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failure(error: unknown): PresentationErrorCode {
  return error instanceof PresentationError ? error.code : "conversion_failed";
}

export function createPresentationService(deps: {
  store: PresentationStore;
  convert: PresentationConverter;
  inspect: PdfInspector;
  resolve: HostResolver;
  isPublicAddress: (address: string) => boolean;
  roster: WhiteboardRoster;
  broadcast: PresentationBroadcaster;
  // The presentation the stage shows now, which cannot be removed.
  currentPresentation: (sessionId: string) => Promise<string | null>;
  newId: () => string;
  now: () => string;
  // Conversions run after the upload request returns. Production hands them
  // to a worker queue; tests await them.
  schedule?: (job: () => Promise<void>) => void;
  // Origins imported without the public-address check. Empty in production;
  // the DEV playground lists its own sample page server.
  trustedOrigins?: ReadonlyArray<string>;
  timeoutMs?: number;
  concurrency?: number;
}) {
  const timeoutMs = deps.timeoutMs ?? 90_000;
  const concurrency = deps.concurrency ?? 2;
  const waiting: Array<() => void> = [];
  let running = 0;

  async function member(sessionId: string, userId: string) {
    const roster = await deps.roster(sessionId);
    if (roster.hostIds.includes(userId)) return { host: true, hostIds: roster.hostIds };
    if (roster.memberIds.includes(userId)) return { host: false, hostIds: roster.hostIds };
    throw new WhiteboardError("forbidden");
  }

  async function host(sessionId: string, userId: string) {
    const actor = await member(sessionId, userId);
    if (!actor.host) throw new WhiteboardError("forbidden");
    return actor;
  }

  // Upload progress and results go to the hosts only, like BigBlueButton's
  // presenter-only upload list.
  async function announce(record: Presentation, hostIds: string[]) {
    try {
      await deps.broadcast({ sessionId: record.sessionId, message: { kind: "presentation", presentation: record }, destinationIdentities: hostIds });
    } catch {
      console.info(JSON.stringify({ type: "whiteboard.presentation_broadcast_failed", id: record.id }));
    }
  }

  async function slot<T>(work: () => Promise<T>) {
    if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  async function convert(record: Presentation, input: { source: "pdf"; bytes: Uint8Array } | ConversionInput, hostIds: string[]) {
    let done: Presentation;
    try {
      const pdf = await slot(() => {
        if (input.source === "pdf") return Promise.resolve(input.bytes);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PresentationError("conversion_timeout")), timeoutMs); });
        return Promise.race([deps.convert(input), timeout]).finally(() => clearTimeout(timer));
      });
      if (!pdf.length) throw new PresentationError("empty");
      const { pageCount } = await deps.inspect(pdf);
      if (pageCount < 1) throw new PresentationError("empty");
      if (pageCount > PRESENTATION_LIMITS.maxPages) throw new PresentationError("page_count_exceeded");
      await deps.store.putFile(record.id, "pdf", pdf);
      done = await deps.store.update(record.id, { status: "ready", pageCount });
    } catch (error) {
      const code = failure(error);
      if (code === "conversion_failed") console.info(JSON.stringify({ type: "whiteboard.conversion_failed", id: record.id, source: record.source, message: error instanceof Error ? error.message.slice(0, 200) : "" }));
      done = await deps.store.update(record.id, { status: "failed", error: code });
    }
    await announce(done, hostIds);
  }

  function trusted(raw: unknown) {
    if (typeof raw !== "string" || !deps.trustedOrigins?.length) return null;
    try {
      const url = new URL(raw);
      return deps.trustedOrigins.includes(url.origin) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  async function assertPublic(url: URL) {
    let addresses: string[];
    try {
      addresses = await deps.resolve(url.hostname.replace(/^\[|\]$/g, ""));
    } catch {
      throw new PresentationError("unreachable");
    }
    if (!addresses.length) throw new PresentationError("unreachable");
    if (!addresses.every(deps.isPublicAddress)) throw new PresentationError("blocked_url");
  }

  function start(job: () => Promise<void>) {
    if (deps.schedule) deps.schedule(job);
    else void job();
  }

  async function begin(sessionId: string, actorUserId: string, hostIds: string[], draft: { name: string; source: PresentationSource; origin: string; contentKey: string }, input: { source: "pdf"; bytes: Uint8Array } | ConversionInput, original?: Uint8Array) {
    const existing = await deps.store.list(sessionId);
    const same = existing.find((item) => item.contentKey === draft.contentKey);
    // Idempotent: the same file (or address) again returns the presentation
    // already made from it; only a failed one is converted again.
    if (same && same.status !== "failed") return same;
    if (!same && existing.length >= PRESENTATION_LIMITS.perSession) throw new PresentationError("too_many");
    const { record, created } = same
      ? { record: await deps.store.update(same.id, { status: "converting", pageCount: 0 }), created: false }
      : await deps.store.create({ id: deps.newId(), sessionId, ...draft, status: "converting", pageCount: 0, uploadedBy: actorUserId, createdAt: deps.now() });
    if (!created && !same) return record;
    if (original) await deps.store.putFile(record.id, "original", original);
    await announce(record, hostIds);
    start(() => convert(record, input, hostIds));
    return record;
  }

  return {
    async upload(input: { actorUserId: string; sessionId: string; name: string; bytes: Uint8Array }) {
      const actor = await host(input.sessionId, input.actorUserId);
      const { source, extension } = sniffUpload(input.name, input.bytes);
      const draft = { name: displayName(input.name), source, origin: extension, contentKey: await sha256(input.bytes) };
      const conversion = source === "pdf" ? { source, bytes: input.bytes } as const : { source, extension, bytes: input.bytes };
      return begin(input.sessionId, input.actorUserId, actor.hostIds, draft, conversion, input.bytes);
    },

    // Imports a web page as a static PDF snapshot. The address must resolve
    // to the public internet only; the converter checks again for every
    // request the page makes, so a redirect cannot reach the private network.
    async importWeb(input: { actorUserId: string; sessionId: string; url: unknown }) {
      const actor = await host(input.sessionId, input.actorUserId);
      const url = trusted(input.url) ?? parseImportUrl(input.url);
      if (!trusted(url.toString())) await assertPublic(url);
      const draft = { name: (url.hostname + url.pathname.replace(/\/$/, "")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, PRESENTATION_LIMITS.maxNameLength), source: "web" as const, origin: url.toString(), contentKey: await sha256(url.toString()) };
      return begin(input.sessionId, input.actorUserId, actor.hostIds, draft, { source: "web", url });
    },

    async list(input: { actorUserId: string; sessionId: string }) {
      await host(input.sessionId, input.actorUserId);
      return deps.store.list(input.sessionId);
    },

    async get(input: { actorUserId: string; sessionId: string; id: string }) {
      await member(input.sessionId, input.actorUserId);
      const record = await deps.store.get(input.sessionId, input.id);
      if (!record) throw new PresentationError("unsupported");
      return record;
    },

    // The converted PDF every browser renders. Members of the session only.
    async file(input: { actorUserId: string; sessionId: string; id: string }) {
      await member(input.sessionId, input.actorUserId);
      const record = await deps.store.get(input.sessionId, input.id);
      if (!record || record.status !== "ready") return null;
      return deps.store.getFile(record.id, "pdf");
    },

    async remove(input: { actorUserId: string; sessionId: string; id: string }) {
      await host(input.sessionId, input.actorUserId);
      const record = await deps.store.get(input.sessionId, input.id);
      if (!record) return false;
      if ((await deps.currentPresentation(input.sessionId)) === record.id) throw new PresentationError("in_use");
      await deps.store.remove(input.sessionId, record.id);
      return true;
    },

    // The converter's per-request check for a web import: the page's own
    // requests may go to trusted origins or to the public internet only.
    async allowedRequest(url: URL) {
      if (trusted(url.toString())) return true;
      try {
        await assertPublic(parseImportUrl(url.toString()));
        return true;
      } catch {
        return false;
      }
    },

    // For the stage's "present" command: a ready presentation of this session.
    async ref(sessionId: string, id: string): Promise<PresentationRef | null> {
      const record = await deps.store.get(sessionId, id);
      return record && record.status === "ready" ? { id: record.id, name: record.name, pageCount: record.pageCount } : null;
    }
  };
}

export type PresentationService = ReturnType<typeof createPresentationService>;

export function createMemoryPresentationStore(): PresentationStore {
  const records = new Map<string, Presentation>();
  const files = new Map<string, Uint8Array>();
  return {
    async create(record) {
      const same = [...records.values()].find((item) => item.sessionId === record.sessionId && item.contentKey === record.contentKey);
      if (same) return { record: same, created: false };
      records.set(record.id, record);
      return { record, created: true };
    },
    async update(id, patch) {
      const current = records.get(id);
      if (!current) throw new PresentationError("unsupported");
      const { error: _previous, ...rest } = current;
      const next: Presentation = { ...rest, ...patch };
      records.set(id, next);
      return next;
    },
    async get(sessionId, id) {
      const record = records.get(id);
      return record && record.sessionId === sessionId ? record : null;
    },
    async list(sessionId) {
      return [...records.values()].filter((item) => item.sessionId === sessionId);
    },
    async remove(sessionId, id) {
      if (records.get(id)?.sessionId !== sessionId) return;
      records.delete(id);
      files.delete(`${id}/original`);
      files.delete(`${id}/pdf`);
    },
    async putFile(id, kind, bytes) {
      files.set(`${id}/${kind}`, bytes);
    },
    async getFile(id, kind) {
      return files.get(`${id}/${kind}`) ?? null;
    }
  };
}
