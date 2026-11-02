import assert from "node:assert/strict";
import { test } from "node:test";
import { WhiteboardError } from "../../modules/whiteboard/domain";
import { isPublicAddress, parseImportUrl, PresentationError, PRESENTATION_LIMITS, sniffUpload, type Presentation } from "../../modules/whiteboard/presentation";
import { createMemoryPresentationStore, createPresentationService, type ConversionInput } from "../../modules/whiteboard/presentationService";
import type { WhiteboardMessage } from "../../modules/whiteboard/wire";

const session = "s1";
const bytes = (...head: number[]) => new Uint8Array([...head, ...new Array(64).fill(32)]);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

function codeOf(fn: () => unknown) {
  try {
    fn();
    return "returned";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof PresentationError || error instanceof WhiteboardError ? error.code : `unexpected ${String(error)}`;
  }
}

function harness(options: { pages?: number; convert?: (input: ConversionInput) => Promise<Uint8Array>; resolve?: (host: string) => Promise<string[]>; current?: string | null; trusted?: string[] } = {}) {
  const jobs: Array<Promise<void>> = [];
  const sent: Array<{ message: WhiteboardMessage; to?: string[] }> = [];
  const conversions: ConversionInput[] = [];
  let ids = 0;
  const service = createPresentationService({
    store: createMemoryPresentationStore(),
    convert: async (input) => { conversions.push(input); return options.convert ? options.convert(input) : PDF; },
    inspect: async () => ({ pageCount: options.pages ?? 3 }),
    resolve: options.resolve ?? (async () => ["93.184.216.34"]),
    isPublicAddress,
    roster: async () => ({ hostIds: ["prof"], memberIds: ["amy"] }),
    broadcast: async ({ message, destinationIdentities }) => { sent.push({ message, ...(destinationIdentities ? { to: destinationIdentities } : {}) }); },
    currentPresentation: async () => options.current ?? null,
    newId: () => `p_test${String(++ids).padStart(4, "0")}`,
    now: () => "2026-11-02T00:00:00.000Z",
    schedule: (job) => { jobs.push(job()); },
    trustedOrigins: options.trusted ?? [],
    timeoutMs: 50
  });
  const settle = () => Promise.all(jobs.splice(0));
  return { service, sent, conversions, settle };
}

test("an upload is what its first bytes say, and its extension must agree", () => {
  assert.deepEqual(sniffUpload("Forces.pdf", PDF), { source: "pdf", extension: "pdf" });
  assert.deepEqual(sniffUpload("Lesson 3.PPTX", ZIP), { source: "office", extension: "pptx" });
  assert.deepEqual(sniffUpload("old.ppt", OLE), { source: "office", extension: "ppt" });
  assert.deepEqual(sniffUpload("board.png", PNG), { source: "image", extension: "png" });
  assert.equal(codeOf(() => sniffUpload("evil.pdf", HTML)), "unsupported", "an HTML page renamed .pdf");
  assert.equal(codeOf(() => sniffUpload("slides.pptx", PDF)), "unsupported", "a PDF renamed .pptx");
  assert.equal(codeOf(() => sniffUpload("macro.pptm", ZIP)), "unsupported", "macro-enabled formats are not accepted");
  assert.equal(codeOf(() => sniffUpload("tool.exe", bytes(0x4d, 0x5a))), "unsupported");
  assert.equal(codeOf(() => sniffUpload("empty.pdf", new Uint8Array())), "empty");
  assert.equal(codeOf(() => sniffUpload("huge.pdf", new Uint8Array(PRESENTATION_LIMITS.maxBytes + 1))), "too_large");
});

test("the host uploads; the PDF is checked and stored, and only the hosts hear the progress", async () => {
  const { service, sent, settle, conversions } = harness({ pages: 12 });
  assert.equal(await code(service.upload({ actorUserId: "amy", sessionId: session, name: "x.pdf", bytes: PDF })), "forbidden", "members do not upload");
  assert.equal(await code(service.upload({ actorUserId: "eve", sessionId: session, name: "x.pdf", bytes: PDF })), "forbidden");
  const started = await service.upload({ actorUserId: "prof", sessionId: session, name: "../../etc/Forces\u0000.pdf", bytes: PDF });
  assert.equal(started.status, "converting");
  assert.equal(started.name, "Forces.pdf", "no path or control characters in the shown name");
  await settle();
  assert.equal(conversions.length, 0, "a PDF needs no converter");
  const ready = await service.get({ actorUserId: "amy", sessionId: session, id: started.id });
  assert.deepEqual([ready.status, ready.pageCount], ["ready", 12]);
  assert.deepEqual(sent.map((item) => [(item.message as { presentation: Presentation }).presentation.status, item.to]), [["converting", ["prof"]], ["ready", ["prof"]]]);
  assert.deepEqual(await service.file({ actorUserId: "amy", sessionId: session, id: started.id }), PDF, "every member renders the same PDF");
  assert.equal(await code(service.file({ actorUserId: "eve", sessionId: session, id: started.id })), "forbidden");
  assert.deepEqual(await service.ref(session, started.id), { id: started.id, name: "Forces.pdf", pageCount: 12 });
  assert.equal(await service.ref("other-session", started.id), null, "a deck belongs to its session");
});

test("the same file twice is one presentation; a failed one is converted again", async () => {
  let fail = true;
  const { service, settle, conversions } = harness({ convert: async () => { if (fail) throw new Error("soffice crashed"); return PDF; } });
  const first = await service.upload({ actorUserId: "prof", sessionId: session, name: "Deck.pptx", bytes: ZIP });
  await settle();
  assert.deepEqual([(await service.get({ actorUserId: "prof", sessionId: session, id: first.id })).status, (await service.get({ actorUserId: "prof", sessionId: session, id: first.id })).error], ["failed", "conversion_failed"]);
  fail = false;
  const again = await service.upload({ actorUserId: "prof", sessionId: session, name: "Deck (copy).pptx", bytes: ZIP });
  await settle();
  assert.equal(again.id, first.id);
  const ready = await service.get({ actorUserId: "prof", sessionId: session, id: first.id });
  assert.deepEqual([ready.status, ready.error], ["ready", undefined]);
  const third = await service.upload({ actorUserId: "prof", sessionId: session, name: "Deck.pptx", bytes: ZIP });
  await settle();
  assert.equal(third.id, first.id);
  assert.equal(conversions.length, 2, "a ready deck is not converted again");
  assert.equal((await service.list({ actorUserId: "prof", sessionId: session })).length, 1);
});

test("conversion limits: too many pages, a converter that hangs, and the per-session cap", async () => {
  const big = harness({ pages: PRESENTATION_LIMITS.maxPages + 1 });
  const deck = await big.service.upload({ actorUserId: "prof", sessionId: session, name: "Huge.pdf", bytes: PDF });
  await big.settle();
  assert.equal((await big.service.get({ actorUserId: "prof", sessionId: session, id: deck.id })).error, "page_count_exceeded");
  assert.equal(await big.service.file({ actorUserId: "prof", sessionId: session, id: deck.id }), null, "a failed deck has no file");
  const slow = harness({ convert: () => new Promise(() => {}) });
  const stuck = await slow.service.upload({ actorUserId: "prof", sessionId: session, name: "Slow.docx", bytes: ZIP });
  await slow.settle();
  assert.equal((await slow.service.get({ actorUserId: "prof", sessionId: session, id: stuck.id })).error, "conversion_timeout");
  const many = harness();
  for (let index = 0; index < PRESENTATION_LIMITS.perSession; index += 1) {
    await many.service.upload({ actorUserId: "prof", sessionId: session, name: `d${index}.pdf`, bytes: new Uint8Array([...PDF, index]) });
  }
  assert.equal(await code(many.service.upload({ actorUserId: "prof", sessionId: session, name: "one-more.pdf", bytes: new Uint8Array([...PDF, 250]) })), "too_many");
});

test("the deck on stage cannot be removed; others can", async () => {
  const { service, settle } = harness({ current: "p_test0001" });
  const shown = await service.upload({ actorUserId: "prof", sessionId: session, name: "a.pdf", bytes: PDF });
  const spare = await service.upload({ actorUserId: "prof", sessionId: session, name: "b.pdf", bytes: new Uint8Array([...PDF, 1]) });
  await settle();
  assert.equal(await code(service.remove({ actorUserId: "prof", sessionId: session, id: shown.id })), "in_use");
  assert.equal(await code(service.remove({ actorUserId: "amy", sessionId: session, id: spare.id })), "forbidden");
  assert.equal(await service.remove({ actorUserId: "prof", sessionId: session, id: spare.id }), true);
  assert.equal(await service.file({ actorUserId: "prof", sessionId: session, id: spare.id }), null);
});

test("web import: public pages only, checked by address after DNS and for every request", async () => {
  assert.equal(codeOf(() => parseImportUrl("ftp://example.com/a")), "blocked_url");
  assert.equal(codeOf(() => parseImportUrl("https://user:pw@example.com/")), "blocked_url");
  assert.equal(codeOf(() => parseImportUrl("http://169.254.169.254/latest/meta-data/")), "blocked_url", "cloud metadata");
  assert.equal(codeOf(() => parseImportUrl("http://127.0.0.1:3000/")), "blocked_url");
  assert.equal(codeOf(() => parseImportUrl("http://[::1]/")), "blocked_url");
  assert.equal(codeOf(() => parseImportUrl("http://localhost/")), "blocked_url");
  assert.equal(codeOf(() => parseImportUrl("http://printer.local/")), "blocked_url");
  assert.equal(parseImportUrl(" https://example.com/notes#part-2 ").toString(), "https://example.com/notes");

  const rebinding = harness({ resolve: async () => ["93.184.216.34", "10.0.0.5"] });
  assert.equal(await code(rebinding.service.importWeb({ actorUserId: "prof", sessionId: session, url: "https://intranet.example.com/" })), "blocked_url", "any private answer blocks the name");
  assert.equal(await rebinding.service.allowedRequest(new URL("https://intranet.example.com/x.js")), false, "and the page's own requests to it");

  const { service, settle, conversions } = harness();
  assert.equal(await code(service.importWeb({ actorUserId: "amy", sessionId: session, url: "https://example.com/" })), "forbidden");
  const page = await service.importWeb({ actorUserId: "prof", sessionId: session, url: "https://example.com/physics/forces/" });
  await settle();
  assert.deepEqual([page.source, page.name, page.origin], ["web", "example.com/physics/forces", "https://example.com/physics/forces/"]);
  assert.equal(conversions[0].source, "web");
  assert.equal((await service.importWeb({ actorUserId: "prof", sessionId: session, url: "https://example.com/physics/forces/" })).id, page.id, "same address, same deck");
  assert.equal(await service.allowedRequest(new URL("file:///etc/passwd")), false);

  const dev = harness({ trusted: ["http://127.0.0.1:8765"] });
  assert.equal((await dev.service.importWeb({ actorUserId: "prof", sessionId: session, url: "http://127.0.0.1:8765/index.html" })).source, "web", "the DEV sample server is trusted explicitly");
  assert.equal(await dev.service.allowedRequest(new URL("http://127.0.0.1:9999/")), false, "only that origin");
});

test("isPublicAddress", () => {
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(address), true, address);
  for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "2001:db8::1", "64:ff9b::a00:1", "ff02::1", "not-an-ip"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});
