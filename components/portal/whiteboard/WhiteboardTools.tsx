"use client";

// The whiteboard toolbar, after BigBlueButton's: a vertical strip beside the
// slide with the tools, colour, thickness, undo, redo, clear and (for the
// host) the multi-user switch. Popovers open to the left of the strip.

import { useState } from "react";
import { ArrowUpRight, Circle, Eraser, Hand, Highlighter, Minus, Pencil, Redo2, Shapes, Square, Trash2, Triangle, Type, Undo2, Users } from "lucide-react";
import { WHITEBOARD_COLORS } from "@/modules/whiteboard/domain";
import type { Tool, ToolKind } from "./BoardCanvas";
import styles from "./whiteboard.module.css";

const COLOR_NAMES = ["黑", "白", "红", "橙", "亮黄绿", "绿", "青", "天蓝", "蓝", "紫", "品红", "银灰"];
const SHAPES: Array<{ kind: ToolKind; label: string; icon: typeof Square }> = [
  { kind: "line", label: "直线", icon: Minus },
  { kind: "arrow", label: "箭头", icon: ArrowUpRight },
  { kind: "rect", label: "矩形", icon: Square },
  { kind: "ellipse", label: "椭圆", icon: Circle },
  { kind: "triangle", label: "三角形", icon: Triangle }
];

type Menu = "shapes" | "color" | "size" | "clear" | null;

export function WhiteboardTools(props: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  canPan: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  host: boolean;
  everyone?: boolean;
  onEveryone?: (on: boolean) => void;
}) {
  const { tool, onTool } = props;
  const [menu, setMenu] = useState<Menu>(null);
  const toggle = (next: Menu) => setMenu((current) => (current === next ? null : next));
  const pick = (patch: Partial<Tool>) => { onTool({ ...tool, ...patch }); setMenu(null); };
  const shape = SHAPES.find((item) => item.kind === tool.kind);
  const ShapeIcon = shape?.icon ?? Shapes;

  const button = (kind: ToolKind, label: string, Icon: typeof Square, disabled = false) => (
    <button type="button" className={styles.toolIcon} aria-pressed={tool.kind === kind} aria-label={label} title={label} disabled={disabled} onClick={() => pick({ kind })}>
      <Icon size={18} strokeWidth={2} />
    </button>
  );

  return (
    <div className={styles.toolStrip} role="toolbar" aria-label="白板工具" aria-orientation="vertical">
      {button("pan", props.canPan ? "平移" : "平移（放大后可用）", Hand, !props.canPan)}
      {button("pen", "画笔", Pencil)}
      {button("highlighter", "荧光笔", Highlighter)}
      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolIcon} aria-pressed={!!shape} aria-expanded={menu === "shapes"} aria-label="形状" title="形状" onClick={() => toggle("shapes")}>
          <ShapeIcon size={18} strokeWidth={2} />
        </button>
        {menu === "shapes" ? (
          <div className={styles.popover} role="menu">
            {SHAPES.map(({ kind, label, icon: Icon }) => (
              <button key={kind} type="button" role="menuitemradio" aria-checked={tool.kind === kind} className={styles.popoverItem} onClick={() => pick({ kind })}>
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {button("text", "文字", Type)}
      {button("eraser", "橡皮擦", Eraser)}
      <span className={styles.toolRule} />
      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolIcon} aria-expanded={menu === "color"} aria-label="颜色" title="颜色" onClick={() => toggle("color")}>
          <span className={styles.colorDot} style={{ background: tool.color }} />
        </button>
        {menu === "color" ? (
          <div className={`${styles.popover} ${styles.popoverGrid}`} role="menu" aria-label="颜色">
            {WHITEBOARD_COLORS.map((color, index) => (
              <button key={color} type="button" role="menuitemradio" aria-checked={tool.color === color} aria-label={COLOR_NAMES[index]} title={COLOR_NAMES[index]} className={styles.swatch} style={{ background: color }} onClick={() => pick({ color })} />
            ))}
          </div>
        ) : null}
      </div>
      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolIcon} aria-expanded={menu === "size"} aria-label="粗细" title="粗细" onClick={() => toggle("size")}>
          <span className={styles.sizeDot} style={{ width: 6 + tool.size * 5, height: 6 + tool.size * 5 }} />
        </button>
        {menu === "size" ? (
          <div className={styles.popover} role="menu" aria-label="粗细">
            {(["细", "中", "粗"] as const).map((label, size) => (
              <button key={label} type="button" role="menuitemradio" aria-checked={tool.size === size} className={styles.popoverItem} onClick={() => pick({ size: size as Tool["size"] })}>
                <span className={styles.sizeDot} style={{ width: 6 + size * 5, height: 6 + size * 5 }} /> {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <span className={styles.toolRule} />
      <button type="button" className={styles.toolIcon} aria-label="撤销" title="撤销" disabled={!props.canUndo} onClick={props.onUndo}><Undo2 size={18} /></button>
      <button type="button" className={styles.toolIcon} aria-label="重做" title="重做" disabled={!props.canRedo} onClick={props.onRedo}><Redo2 size={18} /></button>
      <div className={styles.toolGroup}>
        <button type="button" className={styles.toolIcon} aria-expanded={menu === "clear"} aria-label="清空标注" title="清空标注" onClick={() => toggle("clear")}><Trash2 size={18} /></button>
        {menu === "clear" ? (
          <div className={styles.popover} role="dialog" aria-label="清空标注">
            <p className={styles.popoverText}>{props.host ? "确定清空这一页的所有标注吗？" : "确定清空你在这块板上的内容吗？"}</p>
            <div className={styles.popoverActions}>
              <button type="button" className={styles.button} onClick={() => setMenu(null)}>取消</button>
              <button type="button" className={`${styles.button} ${styles.buttonDanger}`} onClick={() => { setMenu(null); props.onClear(); }}>清空</button>
            </div>
          </div>
        ) : null}
      </div>
      {props.host && props.onEveryone ? (
        <>
          <span className={styles.toolRule} />
          <button type="button" className={styles.toolIcon} aria-pressed={!!props.everyone} aria-label={props.everyone ? "关闭多人白板" : "开启多人白板"} title={props.everyone ? "关闭多人白板" : "开启多人白板"} onClick={() => props.onEveryone?.(!props.everyone)}>
            <Users size={18} />
          </button>
        </>
      ) : null}
    </div>
  );
}
