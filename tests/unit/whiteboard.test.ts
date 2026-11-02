import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_BOARD, parseStroke, receiveOp, replay, WhiteboardError, WHITEBOARD_LIMITS, type BoardOp } from "../../modules/whiteboard/domain";
import { createLiveKitWhiteboardBroadcaster } from "../../modules/whiteboard/liveKitBroadcaster";
import { createMemoryWhiteboardStore, createWhiteboardService } from "../../modules/whiteboard/service";
import { audience, canSee, initialStage, parseBoardKey, parseStageCommand } from "../../modules/whiteboard/stage";
import { encodeInk, encodeWhiteboardMessage, parseInk, parseWhiteboardMessage, whiteboardPacket, WHITEBOARD_INK_TOPIC, WHITEBOARD_TOPIC, type WhiteboardMessage } from "../../modules/whiteboard/wire";
import { parseRoomDataMessage } from "../../modules/group-study/roomData";

const session = "s1";
const stroke = (id: string, extra: Record<string, unknown> = {}) => ({ id, color: "#0090ff", width: 24, points: [[100, 100], [200, 220], [300, 260]], ...extra });
type Sent = { message: WhiteboardMessage; to?: string[] };

async function harness() {
  const sent: Sent[] = [];
  const service = createWhiteboardService({
    store: createMemoryWhiteboardStore(),
    roster: async () => ({ hostIds: ["prof"], memberIds: ["amy", "ben"] }),
    broadcast: async ({ message, destinationIdentities }) => { sent.push({ message, ...(destinationIdentities ? { to: destinationIdentities } : {}) }); },
    presentations: async (_sessionId, id) => (id === "deck01" ? { id, name: "Forces.pdf", pageCount: 4 } : null)
  });
  await service.open({ actorUserId: "prof", sessionId: session });
  const host = (command: unknown) => service.command({ actorUserId: "prof", sessionId: session, command });
  await host({ type: "present", presentationId: "deck01" });
  return { service, sent, host };
}

async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof WhiteboardError ? error.code : `unexpected ${String(error)}`;
  }
  return "resolved";
}

test("a stroke on the main board is stored with the next sequence, then sent to the whole room", async () => {
  const { service, sent } = await harness();
  const first = await service.draw({ actorUserId: "prof", sessionId: session, board: "main/deck01/0", stroke: stroke("stroke-0001") });
  const second = await service.draw({ actorUserId: "prof", sessionId: session, board: "main/deck01/0", stroke: stroke("stroke-0002") });
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  const ops = sent.filter((item) => item.message.kind === "op");
  assert.equal(ops.length, 2);
  assert.ok(ops.every((item) => !item.to), "main board ops go to everyone");
  const board = replay(await service.ops({ actorUserId: "amy", sessionId: session, board: "main/deck01/0", after: 0 }));
  assert.deepEqual(board.strokes.map((item) => [item.id, item.authorId]), [["stroke-0001", "prof"], ["stroke-0002", "prof"]]);
});

test("a retried stroke is stored and sent once; pages have separate logs", async () => {
  const { service, sent } = await harness();
  await service.draw({ actorUserId: "prof", sessionId: session, board: "main/deck01/0", stroke: stroke("stroke-0001") });
  assert.equal((await service.draw({ actorUserId: "prof", sessionId: session, board: "main/deck01/0", stroke: stroke("stroke-0001") })).seq, 1);
  assert.equal((await service.draw({ actorUserId: "prof", sessionId: session, board: "main/deck01/1", stroke: stroke("stroke-0001") })).seq, 1);
  assert.equal(sent.filter((item) => item.message.kind === "op").length, 2);
});

test("the pen: a member draws on the main board only while holding it, on the current page, unlocked", async () => {
  const { service, host } = await harness();
  const draw = (id: string, board = "main/deck01/0") => service.draw({ actorUserId: "amy", sessionId: session, board, stroke: stroke(id) });
  assert.equal(await code(draw("amy-00001")), "forbidden");
  await host({ type: "grant_pen", userId: "amy" });
  assert.equal(await code(draw("amy-00001")), "resolved");
  assert.equal(await code(draw("amy-00002", "main/deck01/1")), "forbidden", "not the current page");
  await host({ type: "lock", on: true });
  assert.equal(await code(draw("amy-00003")), "forbidden", "locked");
  await host({ type: "lock", on: false });
  await host({ type: "revoke_pen", userId: "amy" });
  assert.equal(await code(draw("amy-00004")), "forbidden");
  assert.equal(await code(service.draw({ actorUserId: "eve", sessionId: session, board: "main/deck01/0", stroke: stroke("eve-00001") })), "forbidden");
  assert.equal(await code(host({ type: "grant_pen", userId: "eve" })), "not_found", "the pen goes to someone in the session only");
});

test("only the host runs the stage; repeated commands change nothing", async () => {
  const { service, sent, host } = await harness();
  assert.equal(await code(service.command({ actorUserId: "amy", sessionId: session, command: { type: "work", on: true } })), "forbidden");
  const before = sent.length;
  const moved = await host({ type: "goto", page: 2 });
  assert.equal(moved.page, 2);
  assert.equal((await host({ type: "goto", page: 2 })).version, moved.version);
  assert.equal(sent.length, before + 1);
  assert.equal(await code(host({ type: "goto", page: 4 })), "invalid_command");
  assert.equal(await code(host({ type: "drop_table" })), "invalid_command");
});

test("work mode: each member's board reaches only that member and the host until it is spotlighted", async () => {
  const { service, sent, host } = await harness();
  assert.equal(await code(service.draw({ actorUserId: "amy", sessionId: session, board: "member:amy/deck01/0", stroke: stroke("amy-00001") })), "forbidden", "not in work mode");
  await host({ type: "work", on: true });
  await service.draw({ actorUserId: "amy", sessionId: session, board: "member:amy/deck01/0", stroke: stroke("amy-00001") });
  assert.deepEqual(sent.at(-1)!.to, ["amy", "prof"]);
  assert.equal(await code(service.draw({ actorUserId: "ben", sessionId: session, board: "member:amy/deck01/0", stroke: stroke("ben-00001") })), "forbidden", "not your board");
  assert.equal(await code(service.ops({ actorUserId: "ben", sessionId: session, board: "member:amy/deck01/0", after: 0 })), "forbidden", "classmates cannot read it");
  assert.equal((await service.ops({ actorUserId: "prof", sessionId: session, board: "member:amy/deck01/0", after: 0 })).length, 1);
  // The host enlarges amy's board for everyone, annotates it, then ends it.
  await host({ type: "spotlight", userId: "amy", size: "full" });
  assert.equal((await service.ops({ actorUserId: "ben", sessionId: session, board: "member:amy/deck01/0", after: 0 })).length, 1);
  await service.draw({ actorUserId: "prof", sessionId: session, board: "member:amy/deck01/0", stroke: stroke("prof-00001") });
  assert.equal(sent.at(-1)!.to, undefined, "a spotlighted board goes to everyone");
  await host({ type: "spotlight", userId: "amy", size: "split" });
  await host({ type: "end_spotlight" });
  assert.equal(await code(service.ops({ actorUserId: "ben", sessionId: session, board: "member:amy/deck01/0", after: 0 })), "forbidden");
  assert.equal(await code(host({ type: "spotlight", userId: "eve", size: "full" })), "not_found");
});

test("erase and clear: members only their own work, the host anything", async () => {
  const { service, host } = await harness();
  await host({ type: "work", on: true });
  await host({ type: "grant_pen", userId: "amy" });
  await service.draw({ actorUserId: "amy", sessionId: session, board: "main/deck01/0", stroke: stroke("amy-00001") });
  await service.draw({ actorUserId: "prof", sessionId: session, board: "main/deck01/0", stroke: stroke("prof-0001") });
  assert.equal(await code(service.erase({ actorUserId: "amy", sessionId: session, board: "main/deck01/0", strokeId: "prof-0001" })), "forbidden");
  assert.equal(await code(service.erase({ actorUserId: "amy", sessionId: session, board: "main/deck01/0", strokeId: "amy-00001" })), "resolved");
  assert.equal(await code(service.clear({ actorUserId: "amy", sessionId: session, board: "main/deck01/0" })), "forbidden");
  await service.draw({ actorUserId: "ben", sessionId: session, board: "member:ben/deck01/0", stroke: stroke("ben-00001") });
  assert.equal(await code(service.clear({ actorUserId: "amy", sessionId: session, board: "member:ben/deck01/0" })), "forbidden");
  assert.equal(await code(service.clear({ actorUserId: "ben", sessionId: session, board: "member:ben/deck01/0" })), "resolved");
  assert.equal(await service.clear({ actorUserId: "ben", sessionId: session, board: "member:ben/deck01/0" }), null, "clearing an empty board is a no-op");
  await service.clear({ actorUserId: "prof", sessionId: session, board: "main/deck01/0" });
  assert.equal(replay(await service.ops({ actorUserId: "amy", sessionId: session, board: "main/deck01/0", after: 0 })).strokes.length, 0);
});

test("the validation layer rejects bad input and keeps one op inside a LiveKit packet", () => {
  assert.throws(() => parseStroke(stroke("short"), "prof"), WhiteboardError, "id too short");
  assert.throws(() => parseStroke(stroke("stroke-0001", { color: "red" }), "prof"), WhiteboardError);
  assert.throws(() => parseStroke(stroke("stroke-0001", { width: 801 }), "prof"), WhiteboardError);
  assert.throws(() => parseStroke(stroke("stroke-0001", { points: [[1.5, 2]] }), "prof"), WhiteboardError);
  assert.throws(() => parseStroke(stroke("stroke-0001", { points: [[10001, 2]] }), "prof"), WhiteboardError);
  assert.throws(() => parseStroke(stroke("stroke-0001", { points: Array.from({ length: WHITEBOARD_LIMITS.maxPoints + 1 }, () => [1, 1]) }), "prof"), WhiteboardError);
  const biggest = parseStroke(stroke("stroke-0001", { points: Array.from({ length: WHITEBOARD_LIMITS.maxPoints }, () => [10000, 20000]) }), "prof");
  assert.ok(encodeWhiteboardMessage({ kind: "op", board: "member:a-very-long-user-identity-0000000000/p_0123456789abcdef/199", op: { seq: 99999, kind: "stroke", stroke: biggest } }).length < 15 * 1024);
  assert.equal(parseStroke({ ...stroke("stroke-0001"), authorId: "someone-else" }, "prof").authorId, "prof");
  assert.throws(() => parseBoardKey("member:../deck01/0"), WhiteboardError);
  assert.throws(() => parseBoardKey("main/deck01/x"), WhiteboardError);
  assert.throws(() => parseBoardKey("main/0"), WhiteboardError, "a board names its presentation");
  assert.deepEqual(parseBoardKey("member:amy/deck01/3"), { owner: "amy", presentation: "deck01", page: 3 });
  assert.throws(() => parseStageCommand({ type: "spotlight", userId: "amy", size: "huge" }), WhiteboardError);
  const stage = initialStage(session);
  assert.equal(canSee(stage, "member", "ben", { owner: "amy", presentation: "blank", page: 0 }), false);
  assert.deepEqual(audience(stage, { owner: "amy", presentation: "blank", page: 0 }, ["prof", "amy"]), ["amy", "prof"]);
});

test("a browser applies ops in order, drops duplicates and reports gaps", () => {
  const op = (seq: number): BoardOp => ({ seq, kind: "stroke", stroke: { id: `s-${seq}-xxxxx`, authorId: "prof", tool: "pen", color: "#101828", width: 8, points: [[1, 1]] } });
  let board = EMPTY_BOARD;
  ({ board } = receiveOp(board, op(1)));
  assert.equal(board.seq, 1);
  assert.deepEqual(receiveOp(board, op(1)), { board, gap: false });
  const gap = receiveOp(board, op(3));
  assert.equal(gap.gap, true);
  assert.equal(gap.board.seq, 1, "an op after a gap is not applied");
});

test("only server messages are trusted; ink is accepted from members as preview only", () => {
  const message: WhiteboardMessage = { kind: "op", board: "main/deck01/0", op: { seq: 1, kind: "clear", byId: "prof" } };
  const fromServer = whiteboardPacket({ participantIdentity: "", value: { case: "user", value: { payload: encodeWhiteboardMessage(message), topic: WHITEBOARD_TOPIC } } });
  assert.deepEqual(parseWhiteboardMessage(fromServer!.payload, fromServer!.senderIdentity), message);
  const forged = whiteboardPacket({ participantIdentity: "amy", value: { case: "user", value: { payload: encodeWhiteboardMessage({ kind: "stage", stage: initialStage(session) }), topic: WHITEBOARD_TOPIC } } });
  assert.equal(parseWhiteboardMessage(forged!.payload, forged!.senderIdentity), null);
  const ink = encodeInk({ board: "main/deck01/0", strokeId: "amy-1", tool: "pen", color: "#e5484d", width: 10, points: [[-5, 99999], [10, 10]] });
  assert.deepEqual(parseInk(ink, "amy")?.points, [[0, 20000], [10, 10]]);
  assert.equal(parseInk(encodeInk({ board: "main/deck01/0", strokeId: "amy-1", tool: "text" as never, color: "#e5484d", width: 10, points: [] }), "amy"), null, "text has no preview");
  assert.equal(parseInk(ink, ""), null);
  assert.equal(parseInk(encodeInk({ board: "../x", strokeId: "a", tool: "pen", color: "#e5484d", width: 10, points: [] }), "amy"), null);
  assert.equal(whiteboardPacket({ value: { case: "user", value: { payload: ink, topic: "" } } }), null);
  assert.equal(whiteboardPacket({ value: { case: "user", value: { payload: ink, topic: WHITEBOARD_INK_TOPIC } } })?.topic, WHITEBOARD_INK_TOPIC);
  assert.equal(parseRoomDataMessage(encodeWhiteboardMessage(message), true), null, "the chat parser ignores whiteboard packets");
});

test("a broadcast failure does not fail the write", async () => {
  const service = createWhiteboardService({ store: createMemoryWhiteboardStore(), roster: async () => ({ hostIds: ["prof"], memberIds: [] }), broadcast: async () => { throw new Error("livekit down"); } });
  await service.open({ actorUserId: "prof", sessionId: session });
  assert.equal((await service.draw({ actorUserId: "prof", sessionId: session, board: "main/blank/0", stroke: stroke("stroke-0001") })).seq, 1);
});

test("the LiveKit broadcaster sends on the whiteboard topic to the given identities", async () => {
  const calls: Array<{ room: string; topic: string; to?: string[]; body: unknown }> = [];
  const broadcast = createLiveKitWhiteboardBroadcaster({
    roomFor: async (id) => `room-${id}`,
    sendData: async (room, data, options) => { calls.push({ room, topic: options.topic, to: options.destinationIdentities, body: JSON.parse(new TextDecoder().decode(data)) }); }
  });
  const message: WhiteboardMessage = { kind: "op", board: "member:amy/deck01/0", op: { seq: 4, kind: "clear", byId: "prof" } };
  await broadcast({ sessionId: session, message, destinationIdentities: ["amy", "prof"] });
  assert.deepEqual(calls, [{ room: "room-s1", topic: WHITEBOARD_TOPIC, to: ["amy", "prof"], body: message }]);
});

test("tools: two-point shapes carry exactly two points, text carries one point and clean words", () => {
  const shape = (extra: Record<string, unknown>) => ({ id: "shape-0001", color: "#0090ff", width: 24, ...extra });
  assert.equal(parseStroke(shape({ tool: "arrow", points: [[0, 0], [500, 500]] }), "prof").tool, "arrow");
  assert.throws(() => parseStroke(shape({ tool: "rect", points: [[0, 0]] }), "prof"), WhiteboardError);
  assert.throws(() => parseStroke(shape({ tool: "ellipse", points: [[0, 0], [1, 1], [2, 2]] }), "prof"), WhiteboardError);
  assert.equal(parseStroke(shape({ tool: "text", points: [[10, 10]], text: "  F = ma \n a = F/m " }), "prof").text, "F = ma \n a = F/m");
  assert.throws(() => parseStroke(shape({ tool: "text", points: [[10, 10]], text: "   " }), "prof"), WhiteboardError);
  assert.throws(() => parseStroke(shape({ tool: "text", points: [[10, 10]], text: "bell\u0007" }), "prof"), WhiteboardError);
  assert.throws(() => parseStroke(shape({ tool: "text", points: [[10, 10]], text: "x".repeat(WHITEBOARD_LIMITS.maxTextLength + 1) }), "prof"), WhiteboardError);
  assert.throws(() => parseStroke(shape({ tool: "pen", points: [[10, 10]], text: "hidden" }), "prof"), WhiteboardError, "only text carries words");
  assert.throws(() => parseStroke(shape({ tool: "laser", points: [[10, 10]] }), "prof"), WhiteboardError);
  assert.equal(parseStroke(shape({ points: [[10, 10]] }), "prof").tool, "pen", "an old client's stroke is a pen stroke");
});

test("courseware on stage: present resets the page and zoom; only the deck that is up takes ink", async () => {
  const { service, host, sent } = await harness();
  await host({ type: "goto", page: 2 });
  await host({ type: "zoom", viewport: { scale: 2, x: 0.5, y: 0.25 } });
  assert.deepEqual((await service.stage({ actorUserId: "amy", sessionId: session })).stage.viewport, { scale: 2, x: 0.5, y: 0.25 }, "members follow the presenter's zoom");
  assert.equal(await code(host({ type: "zoom", viewport: { scale: 2, x: 0.6, y: 0 } })), "invalid_command", "the window stays on the page");
  assert.equal(await code(host({ type: "zoom", viewport: { scale: 9, x: 0, y: 0 } })), "invalid_command");
  assert.deepEqual((await host({ type: "goto", page: 1 })).viewport, { scale: 1, x: 0, y: 0 }, "a new page starts unzoomed");
  assert.equal(await code(host({ type: "present", presentationId: "nope01" })), "not_found", "only a ready deck of this session");
  const before = sent.length;
  const back = await host({ type: "present", presentationId: "blank" });
  assert.equal(back.presentation.id, "blank");
  assert.equal(back.page, 0);
  assert.equal(sent.length, before + 1);
  assert.equal((await host({ type: "present", presentationId: "blank" })).version, back.version, "presenting the same deck again is a no-op");
  assert.equal(await code(service.draw({ actorUserId: "prof", sessionId: session, board: "main/deck01/0", stroke: stroke("prof-00009") })), "forbidden", "the deck that is down is read-only");
  assert.equal((await service.ops({ actorUserId: "amy", sessionId: session, board: "main/deck01/0", after: 0 })).length, 0, "but its pages can still be read");
});

test("multi-user whiteboard: every member draws on the main board while it is on, never while locked", async () => {
  const { service, host } = await harness();
  const draw = (who: string, id: string) => service.draw({ actorUserId: who, sessionId: session, board: "main/deck01/0", stroke: stroke(id) });
  assert.equal(await code(draw("ben", "ben-00001")), "forbidden");
  await host({ type: "everyone", on: true });
  assert.equal(await code(draw("ben", "ben-00001")), "resolved");
  assert.equal(await code(draw("amy", "amy-00001")), "resolved");
  await host({ type: "lock", on: true });
  assert.equal(await code(draw("amy", "amy-00002")), "forbidden");
  await host({ type: "lock", on: false });
  await host({ type: "everyone", on: false });
  assert.equal(await code(draw("ben", "ben-00002")), "forbidden");
});
