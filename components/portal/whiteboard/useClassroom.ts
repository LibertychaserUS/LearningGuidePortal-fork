"use client";

// One browser's view of the classroom: the stage, the boards it may see, the
// shapes it has sent but not yet seen committed, other people's previews,
// and (for the host) the courseware list. The server is the authority: this
// hook reads the stage and logs on join, on a sequence gap and whenever a
// board becomes visible, and otherwise applies what the room delivers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_BOARD, receiveOp, TWO_POINT_TOOLS, type Board, type Stroke } from "@/modules/whiteboard/domain";
import type { Presentation } from "@/modules/whiteboard/presentation";
import { audience, boardKey, canDraw, parseBoardKey, type Role, type Stage } from "@/modules/whiteboard/stage";
import { encodeInk, parseInk, parseWhiteboardMessage, whiteboardPacket, WHITEBOARD_INK_TOPIC, type InkPreview } from "@/modules/whiteboard/wire";
import type { ClassroomClient } from "./api";

const ERRORS: Record<string, string> = {
  forbidden: "现在不能在这块板上画",
  not_found: "找不到这一笔",
  invalid_command: "这个操作没被接受",
  board_full: "这块板已经画满了",
  version_conflict: "操作冲突，请重试",
  in_use: "正在展示的课件不能删除",
  network_error: "网络不稳定，请重试"
};

export function useClassroom(input: { client: ClassroomClient; hostIds: string[]; memberIds: string[]; onNote?: (line: string) => void }) {
  const { client, hostIds, memberIds, onNote } = input;
  const identity = client.identity;
  const [stage, setStage] = useState<Stage | null>(null);
  const [role, setRole] = useState<Role>("member");
  const [connected, setConnected] = useState(false);
  const [presentations, setPresentations] = useState<Presentation[]>([]);
  const [, setTick] = useState(0);
  const [toast, setToast] = useState("");
  const boards = useRef(new Map<string, Board>());
  const loading = useRef(new Set<string>());
  const pending = useRef(new Map<string, Map<string, Stroke>>());
  const inks = useRef(new Map<string, InkPreview & { at: number; sender: string }>());
  const undone = useRef(new Map<string, Stroke[]>());
  const stageRef = useRef<Stage | null>(null);
  const repairs = useRef(0);
  const bump = useCallback(() => setTick((tick) => tick + 1), []);
  const note = useCallback((line: string) => onNote?.(`${identity}：${line}`), [identity, onNote]);

  const say = useCallback((code: string) => {
    setToast(ERRORS[code] || code);
    setTimeout(() => setToast(""), 2_200);
  }, []);

  const acceptStage = useCallback((next: Stage) => {
    if (stageRef.current && next.version <= stageRef.current.version) return;
    stageRef.current = next;
    setStage(next);
  }, []);

  const acceptPresentation = useCallback((item: Presentation) => {
    setPresentations((list) => list.some((entry) => entry.id === item.id) ? list.map((entry) => entry.id === item.id ? item : entry) : [...list, item]);
  }, []);

  const refreshPresentations = useCallback(async () => {
    try {
      setPresentations(await client.presentations());
    } catch { /* members cannot list; the host retries on open */ }
  }, [client]);

  // Reads a board's ops after the sequence this browser has. Used when a
  // board becomes visible and when a gap shows a broadcast was missed.
  const load = useCallback(async (key: string, reason: "open" | "gap") => {
    if (loading.current.has(key)) return;
    loading.current.add(key);
    try {
      const have = boards.current.get(key) ?? EMPTY_BOARD;
      const ops = await client.ops(key, have.seq);
      let next = boards.current.get(key) ?? EMPTY_BOARD;
      for (const op of ops) next = receiveOp(next, op).board;
      boards.current.set(key, next);
      for (const stroke of next.strokes) pending.current.get(key)?.delete(stroke.id);
      if (reason === "gap") {
        repairs.current += 1;
        note(`补齐 ${key}，读到 ${ops.length} 条，现在 #${next.seq}`);
      }
      bump();
    } catch {
      // Not visible (any more): forget it; the stage decides when to retry.
      boards.current.delete(key);
    } finally {
      loading.current.delete(key);
    }
  }, [bump, client, note]);

  useEffect(() => {
    let alive = true;
    // Subscribe first, then read: nothing between the two is lost, and the
    // version and sequence checks drop whichever copy arrives second.
    const leave = client.join((packet) => {
      if (!alive) return;
      const data = whiteboardPacket(packet);
      if (!data) return;
      if (data.topic === WHITEBOARD_INK_TOPIC) {
        const ink = parseInk(data.payload, data.senderIdentity);
        if (!ink) return;
        const key = `${data.senderIdentity}/${ink.strokeId}`;
        const previous = inks.current.get(key);
        const points = TWO_POINT_TOOLS.includes(ink.tool) ? ink.points : [...(previous?.points ?? []), ...ink.points];
        inks.current.set(key, { ...ink, points, at: Date.now(), sender: data.senderIdentity });
        bump();
        return;
      }
      const message = parseWhiteboardMessage(data.payload, data.senderIdentity);
      if (!message) return;
      if (message.kind === "stage") { acceptStage(message.stage); return; }
      if (message.kind === "presentation") { acceptPresentation(message.presentation); return; }
      const have = boards.current.get(message.board);
      if (!have) return;
      if (message.op.kind === "stroke") {
        inks.current.delete(`${message.op.stroke.authorId}/${message.op.stroke.id}`);
        pending.current.get(message.board)?.delete(message.op.stroke.id);
      }
      const result = receiveOp(have, message.op);
      if (result.gap) { void load(message.board, "gap"); return; }
      if (result.board !== have) { boards.current.set(message.board, result.board); bump(); }
    }, () => setConnected(true));
    // The host may still be opening the board: retry a few times.
    const readStage = (attempt: number) => void client.stage().then((snapshot) => {
      if (!alive) return;
      setRole(snapshot.role);
      acceptStage(snapshot.stage);
      if (snapshot.role === "host") void refreshPresentations();
    }).catch(() => {
      if (alive && attempt < 8) setTimeout(() => readStage(attempt + 1), 300);
      else note("读取课堂状态失败");
    });
    if (hostIds.includes(identity)) void client.open().catch(() => undefined).finally(() => readStage(0));
    else readStage(0);
    const fade = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [key, ink] of inks.current) if (now - ink.at > (ink.done ? 1_500 : 3_000)) { inks.current.delete(key); changed = true; }
      if (changed) bump();
    }, 400);
    return () => { alive = false; leave(); clearInterval(fade); };
  }, [acceptPresentation, acceptStage, bump, client, hostIds, identity, load, note, refreshPresentations]);

  // The boards this browser should hold for the current stage.
  const visible = useMemo(() => {
    if (!stage) return [] as string[];
    const at = { presentation: stage.presentation.id, page: stage.page };
    const keys = [boardKey({ owner: "main", ...at })];
    if (role === "host") {
      if (stage.work || stage.view.kind === "spotlight") for (const member of memberIds) keys.push(boardKey({ owner: member, ...at }));
    } else {
      if (stage.work) keys.push(boardKey({ owner: identity, ...at }));
      if (stage.view.kind === "spotlight") keys.push(boardKey({ owner: stage.view.userId, ...at }));
    }
    return [...new Set(keys)];
  }, [identity, memberIds, role, stage]);

  useEffect(() => {
    for (const key of [...boards.current.keys()]) if (!visible.includes(key)) boards.current.delete(key);
    for (const key of visible) if (!boards.current.has(key)) void load(key, "open");
  }, [load, visible]);

  const run = useCallback(async <T,>(action: () => Promise<T>) => {
    try {
      return await action();
    } catch (error) {
      say((error as { code?: string }).code || "invalid_command");
      return null;
    }
  }, [say]);

  const draw = useCallback((key: string, stroke: Stroke) => {
    const list = pending.current.get(key) ?? new Map<string, Stroke>();
    list.set(stroke.id, stroke);
    pending.current.set(key, list);
    bump();
    void client.draw(key, stroke).catch((error: { code?: string }) => {
      pending.current.get(key)?.delete(stroke.id);
      bump();
      say(error.code || "invalid_command");
    });
  }, [bump, client, say]);

  const publishInk = useCallback((ink: InkPreview) => {
    const current = stageRef.current;
    if (!current) return;
    const to = audience(current, parseBoardKey(ink.board), hostIds)?.filter((id) => id !== identity);
    void client.publishInk(new TextDecoder().decode(encodeInk(ink)), to);
  }, [client, hostIds, identity]);

  return {
    stage,
    role,
    connected,
    toast,
    presentations,
    repairs: repairs.current,
    board: (key: string) => boards.current.get(key),
    pending: (key: string) => [...(pending.current.get(key)?.values() ?? [])],
    inks: (key: string) => [...inks.current.values()].filter((ink) => ink.board === key && ink.sender !== identity),
    mayDraw: (key: string) => !!stage && canDraw(stage, role, identity, parseBoardKey(key)),
    draw: (key: string, stroke: Stroke) => { undone.current.delete(key); draw(key, stroke); },
    publishInk,
    erase: (key: string, strokeId: string) => run(() => client.erase(key, strokeId)),
    // Undo removes this person's last shape on the board; redo puts it back
    // as a new shape (a stroke id is used once per board).
    undo: (key: string) => {
      const mine = (boards.current.get(key)?.strokes ?? []).filter((stroke) => stroke.authorId === identity).at(-1);
      if (!mine) return;
      undone.current.set(key, [...(undone.current.get(key) ?? []), mine]);
      void run(() => client.erase(key, mine.id));
    },
    redo: (key: string) => {
      const stack = undone.current.get(key) ?? [];
      const last = stack.pop();
      if (!last) return;
      draw(key, { ...last, id: `${last.id.slice(0, 50)}-r${Date.now().toString(36).slice(-5)}` });
    },
    canRedo: (key: string) => (undone.current.get(key)?.length ?? 0) > 0,
    clear: (key: string) => run(() => client.clear(key)),
    command: (command: unknown) => run(() => client.command(command)),
    refreshPresentations,
    upload: async (file: File, onProgress: (percent: number) => void) => {
      const created = await client.upload(file, onProgress);
      acceptPresentation(created);
      return created;
    },
    importWeb: async (url: string) => {
      const created = await client.importWeb(url);
      acceptPresentation(created);
      return created;
    },
    removePresentation: async (id: string) => {
      if (await run(() => client.removePresentation(id))) setPresentations((list) => list.filter((item) => item.id !== id));
    },
    read: (id: string) => () => client.file(id)
  };
}

export type Classroom = ReturnType<typeof useClassroom>;
