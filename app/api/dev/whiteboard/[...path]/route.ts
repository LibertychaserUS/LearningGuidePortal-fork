import { NextResponse } from "next/server";
import { WhiteboardError } from "@/modules/whiteboard/domain";
import { devPlayground, resetDevPlayground, type DevPacket } from "@/modules/whiteboard/devPlayground";
import { PresentationError, PRESENTATION_LIMITS } from "@/modules/whiteboard/presentation";

// The whiteboard playground's API (2026-11-02). It answers in `next dev`
// only. The identity is a header (an SSE query parameter for the event
// stream) because the playground has no sign-in; the production routes sit
// under the Study Group session routes and take the signed-in user instead.
// Each handler only parses the request, calls the service and maps the result.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> };

const STATUS: Record<string, number> = {
  invalid_command: 400, forbidden: 403, not_found: 404, board_full: 409, version_conflict: 409,
  too_large: 413, unsupported: 415, empty: 400, page_count_exceeded: 400, conversion_failed: 422, conversion_timeout: 422,
  encrypted: 422, blocked_url: 400, unreachable: 422, too_many: 409, in_use: 409
};

function fail(code: string) {
  return NextResponse.json({ code, message: code, data: null }, { status: STATUS[code] ?? 500 });
}

function ok(data: unknown) {
  return NextResponse.json({ code: "ok", message: "ok", data });
}

async function handle(request: Request, context: Context, work: (path: string[], actor: string) => Promise<Response>) {
  if (process.env.NODE_ENV !== "development") return new NextResponse("Not Found", { status: 404 });
  const { path } = await context.params;
  const actor = request.headers.get("x-dev-user") || new URL(request.url).searchParams.get("as") || "";
  try {
    return await work(path, actor);
  } catch (error) {
    // By code, not class: the playground outlives a hot reload of these modules.
    const code = (error as { code?: unknown }).code;
    if ((error instanceof WhiteboardError || error instanceof PresentationError || error instanceof Error) && typeof code === "string" && code in STATUS) return fail(code);
    console.error(error);
    return fail("internal_error");
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function events(request: Request, identity: string) {
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const unsubscribe = devPlayground().subscribe(identity, (packet: DevPacket) => write(`data: ${JSON.stringify(packet)}\n\n`));
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      stop = () => { unsubscribe(); clearInterval(ping); };
      request.signal.addEventListener("abort", () => { stop(); try { controller.close(); } catch { /* closed */ } });
      write(": ready\n\n");
    },
    cancel() {
      stop();
    }
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}

export async function GET(request: Request, context: Context) {
  return handle(request, context, async (path, actor) => {
    const { whiteboard, presentations } = devPlayground();
    const [sessionId, resource, id, sub] = path;
    const query = new URL(request.url).searchParams;
    if (resource === "events" && path.length === 2) return events(request, actor);
    if (resource === "stage" && path.length === 2) return ok(await whiteboard.stage({ actorUserId: actor, sessionId }));
    if (resource === "ops" && path.length === 2) return ok(await whiteboard.ops({ actorUserId: actor, sessionId, board: query.get("board"), after: Number(query.get("after") || 0) }));
    if (resource === "presentations" && path.length === 2) return ok(await presentations.list({ actorUserId: actor, sessionId }));
    if (resource === "presentations" && path.length === 3) return ok(await presentations.get({ actorUserId: actor, sessionId, id }));
    if (resource === "presentations" && sub === "file" && path.length === 4) {
      const pdf = await presentations.file({ actorUserId: actor, sessionId, id });
      if (!pdf) return fail("not_found");
      return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-length": String(pdf.length), "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-disposition": "inline" } });
    }
    return fail("not_found");
  });
}

export async function POST(request: Request, context: Context) {
  return handle(request, context, async (path, actor) => {
    if (path.length === 1 && path[0] === "reset") {
      resetDevPlayground();
      return ok(true);
    }
    const playground = devPlayground();
    const { whiteboard, presentations } = playground;
    const [sessionId, resource] = path;
    if (path.length !== 2) return fail("not_found");
    if (resource === "loss") {
      playground.setLoss((await body(request)).on === true);
      return ok(true);
    }
    if (resource === "open") return ok(await whiteboard.open({ actorUserId: actor, sessionId }));
    if (resource === "commands") return ok(await whiteboard.command({ actorUserId: actor, sessionId, command: (await body(request)).command }));
    if (resource === "strokes") {
      const input = await body(request);
      return ok(await whiteboard.draw({ actorUserId: actor, sessionId, board: input.board, stroke: input.stroke }));
    }
    if (resource === "erase") {
      const input = await body(request);
      return ok(await whiteboard.erase({ actorUserId: actor, sessionId, board: input.board, strokeId: typeof input.strokeId === "string" ? input.strokeId : "" }));
    }
    if (resource === "clear") return ok(await whiteboard.clear({ actorUserId: actor, sessionId, board: (await body(request)).board }));
    if (resource === "ink") {
      const input = await body(request);
      const to = Array.isArray(input.to) ? input.to.filter((item): item is string => typeof item === "string").slice(0, 50) : undefined;
      if (typeof input.ink !== "string" || input.ink.length > 16_000) return fail("invalid_command");
      // A member can publish only as themselves: the room stamps the sender.
      const roster = await playground.roster();
      if (![...roster.hostIds, ...roster.memberIds].includes(actor)) return fail("forbidden");
      playground.publishInk(actor, input.ink, to);
      return ok(true);
    }
    if (resource === "presentations") {
      if ((request.headers.get("content-type") || "").startsWith("multipart/form-data")) {
        const declared = Number(request.headers.get("content-length") || 0);
        if (declared > PRESENTATION_LIMITS.maxBytes + 64 * 1024) return fail("too_large");
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return fail("empty");
        if (file.size > PRESENTATION_LIMITS.maxBytes) return fail("too_large");
        return ok(await presentations.upload({ actorUserId: actor, sessionId, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }));
      }
      return ok(await presentations.importWeb({ actorUserId: actor, sessionId, url: (await body(request)).url }));
    }
    return fail("not_found");
  });
}

export async function DELETE(request: Request, context: Context) {
  return handle(request, context, async (path, actor) => {
    const [sessionId, resource, id] = path;
    if (resource === "presentations" && path.length === 3) return ok(await devPlayground().presentations.remove({ actorUserId: actor, sessionId, id }));
    return fail("not_found");
  });
}
