"use client";

// One board: the courseware page underneath (SlideLayer), the annotation
// canvas on top, both inside the presenter's zoom window. It draws the
// committed shapes, this browser's shapes still on their way to the server,
// and other people's previews. It owns only the shape being drawn right now
// and the text being typed; everything else comes in through props.

import { useEffect, useRef, useState } from "react";
import { BOARD, TWO_POINT_TOOLS, WHITEBOARD_COLORS, type Board, type Stroke, type WhiteboardTool } from "@/modules/whiteboard/domain";
import type { Viewport } from "@/modules/whiteboard/stage";
import type { InkPreview } from "@/modules/whiteboard/wire";
import { SlideLayer } from "./SlideLayer";
import styles from "./whiteboard.module.css";

export type ToolKind = WhiteboardTool | "eraser" | "pan";
export type Tool = { kind: ToolKind; color: (typeof WHITEBOARD_COLORS)[number]; size: 0 | 1 | 2 };

// Line width (board units) per size step, and the font size for text.
export const SIZES: Record<"line" | "highlighter" | "text", readonly [number, number, number]> = {
  line: [12, 24, 48],
  highlighter: [90, 150, 230],
  text: [170, 250, 380]
};

export function widthOf(tool: Tool) {
  if (tool.kind === "highlighter") return SIZES.highlighter[tool.size];
  if (tool.kind === "text") return SIZES.text[tool.size];
  return SIZES.line[tool.size];
}

const RES_W = 2000;
const SCALE = RES_W / BOARD.width;
const FONT = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", system-ui, sans-serif';

type Shape = { tool?: WhiteboardTool; color: string; width: number; points: ReadonlyArray<readonly [number, number]>; text?: string };

function box(points: Shape["points"]) {
  const [[x0, y0], [x1, y1] = points[0]] = points;
  return { left: Math.min(x0, x1) * SCALE, top: Math.min(y0, y1) * SCALE, width: Math.abs(x1 - x0) * SCALE, height: Math.abs(y1 - y0) * SCALE };
}

function paint(context: CanvasRenderingContext2D, shape: Shape, alpha: number) {
  const points = shape.points;
  if (!points.length) return;
  const tool = shape.tool ?? "pen";
  context.save();
  context.globalAlpha = alpha * (tool === "highlighter" ? 0.38 : 1);
  context.strokeStyle = shape.color;
  context.fillStyle = shape.color;
  context.lineWidth = Math.max(1.5, shape.width * SCALE);
  context.lineCap = "round";
  context.lineJoin = "round";
  const [x0, y0] = points[0];
  context.beginPath();
  if (tool === "text") {
    const size = shape.width * SCALE;
    context.font = `500 ${size}px ${FONT}`;
    context.textBaseline = "top";
    (shape.text ?? "").split("\n").forEach((line, index) => context.fillText(line, x0 * SCALE, y0 * SCALE + index * size * 1.25));
  } else if (tool === "pen" || tool === "highlighter") {
    context.moveTo(x0 * SCALE, y0 * SCALE);
    if (points.length === 1) context.lineTo(x0 * SCALE + 0.1, y0 * SCALE);
    // Midpoint smoothing so a decimated stroke still reads as handwriting.
    for (let index = 1; index < points.length - 1; index += 1) {
      const [x, y] = points[index];
      const [nx, ny] = points[index + 1];
      context.quadraticCurveTo(x * SCALE, y * SCALE, ((x + nx) / 2) * SCALE, ((y + ny) / 2) * SCALE);
    }
    if (points.length > 1) context.lineTo(points[points.length - 1][0] * SCALE, points[points.length - 1][1] * SCALE);
    context.stroke();
  } else {
    const [x1, y1] = points[1] ?? points[0];
    const area = box(points);
    if (tool === "line" || tool === "arrow") {
      context.moveTo(x0 * SCALE, y0 * SCALE);
      context.lineTo(x1 * SCALE, y1 * SCALE);
      if (tool === "arrow" && (x1 !== x0 || y1 !== y0)) {
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const head = Math.max(context.lineWidth * 3.2, 18);
        for (const side of [-1, 1]) {
          context.moveTo(x1 * SCALE, y1 * SCALE);
          context.lineTo(x1 * SCALE - head * Math.cos(angle + side * 0.45), y1 * SCALE - head * Math.sin(angle + side * 0.45));
        }
      }
    } else if (tool === "rect") {
      context.rect(area.left, area.top, area.width, area.height);
    } else if (tool === "ellipse") {
      context.ellipse(area.left + area.width / 2, area.top + area.height / 2, area.width / 2, area.height / 2, 0, 0, Math.PI * 2);
    } else if (tool === "triangle") {
      context.moveTo(area.left + area.width / 2, area.top);
      context.lineTo(area.left + area.width, area.top + area.height);
      context.lineTo(area.left, area.top + area.height);
      context.closePath();
    }
    context.stroke();
  }
  context.restore();
}

function segmentDistance([px, py]: readonly [number, number], [ax, ay]: readonly [number, number], [bx, by]: readonly [number, number]) {
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// How far a point is from a shape, in board units: along the stroke for
// lines, anywhere inside the outline for closed shapes and text.
function distanceTo(stroke: Stroke, point: readonly [number, number]) {
  const tool = stroke.tool;
  if (tool === "pen" || tool === "highlighter") {
    if (stroke.points.length === 1) return Math.hypot(point[0] - stroke.points[0][0], point[1] - stroke.points[0][1]);
    let best = Infinity;
    for (let index = 1; index < stroke.points.length; index += 1) best = Math.min(best, segmentDistance(point, stroke.points[index - 1], stroke.points[index]));
    return best;
  }
  if (tool === "line" || tool === "arrow") return segmentDistance(point, stroke.points[0], stroke.points[1]);
  const [[x0, y0], [x1, y1] = [x0 + Math.max(...(stroke.text ?? "").split("\n").map((line) => line.length)) * stroke.width, y0 + (stroke.text ?? "").split("\n").length * stroke.width * 1.25]] = stroke.points;
  const dx = Math.max(Math.min(x0, x1) - point[0], 0, point[0] - Math.max(x0, x1));
  const dy = Math.max(Math.min(y0, y1) - point[1], 0, point[1] - Math.max(y0, y1));
  return Math.hypot(dx, dy);
}

export function BoardCanvas(props: {
  boardKey: string;
  presentation: string;
  page: number;
  read: () => Promise<Uint8Array>;
  aspect: number;
  viewport: Viewport;
  board: Board | undefined;
  pending?: ReadonlyArray<Stroke>;
  inks?: ReadonlyArray<InkPreview>;
  editable?: boolean;
  active?: boolean;
  tool?: Tool;
  actorId?: string;
  canEraseAny?: boolean;
  testId?: string;
  onAspect?: (aspect: number) => void;
  onStroke?: (stroke: Stroke) => void;
  onInk?: (ink: InkPreview) => void;
  onErase?: (strokeId: string) => void;
  onPan?: (viewport: Viewport) => void;
}) {
  const { board, pending, inks, editable, tool, actorId, aspect } = props;
  const frame = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<{ stroke: Stroke & { points: Array<[number, number]> }; sent: number; at: number } | null>(null);
  const panning = useRef<{ x: number; y: number; from: Viewport } | null>(null);
  const erased = useRef(new Set<string>());
  const erasing = useRef(false);
  const counter = useRef(0);
  const [frameWidth, setFrameWidth] = useState(0);
  const [panView, setPanView] = useState<Viewport | null>(null);
  const [typing, setTyping] = useState<{ x: number; y: number; value: string } | null>(null);
  const viewport = panView ?? props.viewport;
  const resH = Math.round(RES_W * aspect);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setFrameWidth(element.clientWidth));
    observer.observe(element);
    setFrameWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const render = () => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, RES_W, resH);
    for (const stroke of board?.strokes ?? []) paint(context, stroke, 1);
    for (const stroke of pending ?? []) paint(context, stroke, 0.55);
    for (const ink of inks ?? []) paint(context, ink, 0.45);
    if (drawing.current) paint(context, drawing.current.stroke, 0.85);
  };

  useEffect(render);

  const toBoard = (event: React.PointerEvent<HTMLElement>): [number, number] => {
    const rect = (canvasRef.current ?? event.currentTarget).getBoundingClientRect();
    const height = BOARD.width * aspect;
    const x = Math.round(((event.clientX - rect.left) / rect.width) * BOARD.width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * height);
    return [Math.min(BOARD.width, Math.max(0, x)), Math.min(Math.floor(height), BOARD.maxHeight, Math.max(0, y))];
  };

  const sendInk = (done: boolean) => {
    const current = drawing.current;
    if (!current || !props.onInk) return;
    const twoPoint = TWO_POINT_TOOLS.includes(current.stroke.tool);
    const fresh = twoPoint ? current.stroke.points : current.stroke.points.slice(current.sent);
    if (!fresh.length && !done) return;
    props.onInk({ board: props.boardKey, strokeId: current.stroke.id, tool: current.stroke.tool, color: current.stroke.color, width: current.stroke.width, points: fresh, ...(done ? { done: true } : {}) });
    current.sent = current.stroke.points.length;
    current.at = Date.now();
  };

  const newId = () => {
    counter.current += 1;
    return `${(actorId ?? "x").replace(/[^A-Za-z0-9_-]/g, "")}-${Date.now().toString(36)}-${counter.current}`;
  };

  const eraseAt = (point: [number, number]) => {
    const hit = (board?.strokes ?? [])
      .filter((stroke) => !erased.current.has(stroke.id) && (props.canEraseAny || stroke.authorId === actorId))
      .map((stroke) => ({ stroke, distance: distanceTo(stroke, point) }))
      .filter((item) => item.distance < item.stroke.width / 2 + 80)
      .sort((a, b) => a.distance - b.distance)[0];
    if (!hit) return;
    erased.current.add(hit.stroke.id);
    props.onErase?.(hit.stroke.id);
  };

  const commitText = () => {
    if (!typing || !tool || !actorId) return setTyping(null);
    const text = typing.value.trim();
    setTyping(null);
    if (text) props.onStroke?.({ id: newId(), authorId: actorId, tool: "text", color: tool.color, width: widthOf(tool), points: [[typing.x, typing.y]], text });
  };

  const onDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable || !tool || !actorId) return;
    const point = toBoard(event);
    if (tool.kind === "pan") {
      if (props.viewport.scale <= 1 || !props.onPan) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      panning.current = { x: event.clientX, y: event.clientY, from: props.viewport };
      return;
    }
    if (tool.kind === "eraser") {
      event.currentTarget.setPointerCapture(event.pointerId);
      erased.current.clear();
      drawing.current = null;
      panning.current = null;
      eraseAt(point);
      erasing.current = true;
      return;
    }
    if (tool.kind === "text") {
      // Keep the mouse-down from moving focus off the editor it opens.
      event.preventDefault();
      if (typing) commitText();
      else setTyping({ x: point[0], y: point[1], value: "" });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = { stroke: { id: newId(), authorId: actorId, tool: tool.kind, color: tool.color, width: widthOf(tool), points: TWO_POINT_TOOLS.includes(tool.kind) ? [point, point] : [point] }, sent: 0, at: 0 };
    render();
  };

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (erasing.current) return eraseAt(toBoard(event));
    const pan = panning.current;
    if (pan && frame.current) {
      const width = frame.current.clientWidth, height = width * aspect;
      const room = 1 - 1 / pan.from.scale;
      const x = Math.min(room, Math.max(0, pan.from.x - (event.clientX - pan.x) / width / pan.from.scale));
      const y = Math.min(room, Math.max(0, pan.from.y - (event.clientY - pan.y) / height / pan.from.scale));
      setPanView({ scale: pan.from.scale, x: Math.round(x * 10_000) / 10_000, y: Math.round(y * 10_000) / 10_000 });
      return;
    }
    const current = drawing.current;
    if (!current) return;
    const point = toBoard(event);
    if (TWO_POINT_TOOLS.includes(current.stroke.tool)) {
      current.stroke.points[1] = point;
    } else {
      const [lx, ly] = current.stroke.points[current.stroke.points.length - 1];
      if (Math.hypot(point[0] - lx, point[1] - ly) < 20 || current.stroke.points.length >= 600) return;
      current.stroke.points.push(point);
    }
    if (Date.now() - current.at > 50) sendInk(false);
    render();
  };

  const onUp = () => {
    erasing.current = false;
    if (panning.current) {
      panning.current = null;
      if (panView) props.onPan?.(panView);
      setPanView(null);
      return;
    }
    const current = drawing.current;
    if (!current) return;
    sendInk(true);
    drawing.current = null;
    const [a, b] = current.stroke.points;
    // A click with a shape tool draws nothing.
    if (TWO_POINT_TOOLS.includes(current.stroke.tool) && Math.hypot(b[0] - a[0], b[1] - a[1]) < 40) return render();
    props.onStroke?.({ ...current.stroke, points: [...current.stroke.points] });
  };

  const unit = frameWidth / BOARD.width;
  const inner = { transform: `scale(${viewport.scale}) translate(${-viewport.x * 100}%, ${-viewport.y * 100}%)` };
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);

  return (
    <div ref={frame} className={styles.board} style={{ aspectRatio: `1 / ${aspect}`, width: `min(100%, calc(var(--board-max-height, 100000px) * ${(1 / aspect).toFixed(4)}))` }} data-editable={editable ? "true" : "false"} data-tool={tool?.kind} data-active={props.active ? "true" : "false"} data-testid={props.testId} data-board={props.boardKey} data-seq={board?.seq ?? -1}>
      <div className={styles.boardInner} style={inner}>
        <SlideLayer presentation={props.presentation} page={props.page} read={props.read} pixelWidth={Math.round(Math.max(320, frameWidth) * dpr * viewport.scale)} onAspect={props.onAspect} />
        <canvas ref={canvasRef} width={RES_W} height={resH} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
        {typing && tool ? (
          <textarea
            className={styles.textEditor}
            autoFocus
            ref={(node) => { if (node && document.activeElement !== node) requestAnimationFrame(() => node.focus()); }}
            value={typing.value}
            placeholder="输入文字，回车完成"
            maxLength={500}
            style={{ left: `${(typing.x / BOARD.width) * 100}%`, top: `${(typing.y / (BOARD.width * aspect)) * 100}%`, color: tool.color, fontSize: `${Math.max(10, widthOf(tool) * unit)}px` }}
            onChange={(event) => setTyping({ ...typing, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); commitText(); }
              if (event.key === "Escape") setTyping(null);
            }}
            onBlur={commitText}
          />
        ) : null}
      </div>
    </div>
  );
}
