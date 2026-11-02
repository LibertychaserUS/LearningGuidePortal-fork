"use client";

// One person's screen of a live session's whiteboard, laid out after
// BigBlueButton: the participant list and the host's whiteboard management on
// the left, the presentation in the middle with the tool strip beside it and
// the slide controls below, the actions bar at the bottom. Everything shown
// comes from the stage and the boards the server holds (useClassroom).

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Lock, Maximize, Minimize, PencilLine, Plus, Presentation as PresenterIcon, ScanSearch, ZoomIn, ZoomOut } from "lucide-react";
import { WHITEBOARD_COLORS } from "@/modules/whiteboard/domain";
import { BLANK_PRESENTATION, boardKey, FIT_VIEWPORT, STAGE_LIMITS, type Viewport } from "@/modules/whiteboard/stage";
import type { ClassroomClient } from "./api";
import { BoardCanvas, type Tool } from "./BoardCanvas";
import { PresentationUploader } from "./PresentationUploader";
import { BLANK_ASPECT, knownAspect } from "./SlideLayer";
import { useClassroom, type Classroom } from "./useClassroom";
import { WhiteboardTools } from "./WhiteboardTools";
import styles from "./whiteboard.module.css";

export type Person = { name: string; color: string };

const ZOOM_STEPS = [1, 1.25, 1.5, 2, 3, 4];

function Avatar({ person }: { person?: Person }) {
  return <span className={styles.avatar} style={{ background: person?.color || "#98a2b3" }}>{(person?.name || "?").slice(0, 1)}</span>;
}

function Switch({ on, onChange, label, testId }: { on: boolean; onChange: (on: boolean) => void; label: string; testId?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={styles.switch} data-testid={testId} onClick={() => onChange(!on)} />;
}

// Zoom keeps the middle of the window where it is.
function zoomTo(current: Viewport, scale: number): Viewport {
  if (scale <= 1) return FIT_VIEWPORT;
  const cx = current.x + 0.5 / current.scale, cy = current.y + 0.5 / current.scale;
  const room = 1 - 1 / scale;
  const clamp = (value: number) => Math.round(Math.min(room, Math.max(0, value)) * 10_000) / 10_000;
  return { scale, x: clamp(cx - 0.5 / scale), y: clamp(cy - 0.5 / scale) };
}

export function ClassroomRoom(props: { client: ClassroomClient; hostIds: string[]; memberIds: string[]; people: Record<string, Person>; onNote: (line: string) => void }) {
  const { client, hostIds, memberIds, people } = props;
  const identity = client.identity;
  const classroom = useClassroom({ client, hostIds, memberIds, onNote: props.onNote });
  const [tool, setTool] = useState<Tool>({ kind: "pen", color: hostIds.includes(identity) ? WHITEBOARD_COLORS[2] : WHITEBOARD_COLORS[7], size: 1 });
  const [aspect, setAspect] = useState(BLANK_ASPECT);
  const [uploader, setUploader] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const stageArea = useRef<HTMLElement | null>(null);
  // The zoom a click asked for until the server's stage confirms it, so
  // quick repeated clicks step on from each other instead of the old scale.
  const zoomTarget = useRef<{ scale: number; version: number } | null>(null);
  const { stage, role } = classroom;

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === stageArea.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    if (stage) setAspect(knownAspect(stage.presentation.id, stage.page) ?? (stage.presentation.id === BLANK_PRESENTATION.id ? BLANK_ASPECT : aspect));
    // Only a new page can change the shape; the slide reports it when loaded.
  }, [stage?.presentation.id, stage?.page]);

  if (!stage) return <div className={styles.roomLoading}>正在进入课堂…</div>;
  const host = role === "host";
  const at = { presentation: stage.presentation.id, page: stage.page };
  const main = boardKey({ owner: "main", ...at });
  const spot = stage.view.kind === "spotlight" ? stage.view : null;
  const spotKey = spot ? boardKey({ owner: spot.userId, ...at }) : "";
  const own = boardKey({ owner: identity, ...at });
  const deckName = stage.presentation.id === BLANK_PRESENTATION.id ? "空白白板" : stage.presentation.name;
  const name = (id: string) => people[id]?.name ?? id;

  // What this screen shows, in order. The first entry is the one the tool
  // strip acts on (undo, redo, clear).
  const shown: Array<{ key: string; tag: string; accent?: boolean }> = [];
  if (spot && spot.size === "full") shown.push({ key: spotKey, tag: spot.userId === identity ? "你的作答板 · 全员可见" : `${name(spot.userId)} 的作答板 · 全员可见`, accent: true });
  else if (spot) shown.push({ key: main, tag: "课件" }, { key: spotKey, tag: `${name(spot.userId)} 的作答板`, accent: true });
  else if (!host && stage.work) shown.push({ key: own, tag: "我的作答板 · 只有主持人能看到", accent: true });
  else shown.push({ key: main, tag: "课件" });
  const active = shown.find((item) => classroom.mayDraw(item.key))?.key ?? shown[0].key;
  const mayDraw = classroom.mayDraw(active);
  const canMainDraw = (id: string) => stage.everyone || stage.pens.includes(id);

  let banner: { tone?: string; text: string } | null = null;
  if (spot) banner = { text: spot.userId === identity ? "主持人正在向全员展示你的作答板" : host ? `正在向全员展示 ${name(spot.userId)} 的作答板${spot.size === "split" ? "（与课件并排）" : ""}，你可以直接在上面批注` : `主持人正在展示 ${name(spot.userId)} 的作答板` };
  else if (stage.locked && !host) banner = { tone: "locked", text: "主持人已锁定白板，暂时不能书写" };
  else if (stage.work) banner = { tone: "work", text: host ? "成员正在各自的作答板上练习，左侧可以看到每个人的进度" : "请在你自己的作答板上完成练习，其他成员看不到你的作答" };
  else if (!host && canMainDraw(identity)) banner = { tone: "work", text: stage.everyone ? "多人白板已开启，你可以在课件上书写" : "主持人给了你白板权限，你可以在课件上书写" };

  const viewport = stage.viewport;
  const zoom = (scale: number) => void classroom.command({ type: "zoom", viewport: zoomTo(viewport, scale) });
  const step = (direction: 1 | -1) => {
    const pending = zoomTarget.current?.version === stage.version ? zoomTarget.current.scale : viewport.scale;
    const index = ZOOM_STEPS.findIndex((value) => value >= pending - 1e-6);
    const next = Math.min(STAGE_LIMITS.maxScale, ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (index < 0 ? 0 : index) + direction))]);
    zoomTarget.current = { scale: next, version: stage.version };
    zoom(next);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageArea.current?.requestFullscreen?.();
  };
  const boardOf = (key: string, extra: { tag?: string; accent?: boolean; thumb?: boolean; testId?: string } = {}) => (
    <div className={styles.boardFrame} key={key}>
      {extra.tag ? <span className={styles.boardTag} data-accent={extra.accent ? "true" : "false"}>{extra.tag}</span> : null}
      <BoardCanvas
        boardKey={key}
        presentation={stage.presentation.id}
        page={stage.page}
        read={classroom.read(stage.presentation.id)}
        aspect={aspect}
        viewport={extra.thumb ? FIT_VIEWPORT : viewport}
        board={classroom.board(key)}
        pending={classroom.pending(key)}
        inks={classroom.inks(key)}
        editable={!extra.thumb && classroom.mayDraw(key)}
        active={!extra.thumb && key === active && mayDraw && shown.length > 1}
        tool={tool}
        actorId={identity}
        canEraseAny={host}
        testId={extra.testId}
        onAspect={extra.thumb ? undefined : setAspect}
        onStroke={(stroke) => classroom.draw(key, stroke)}
        onInk={classroom.publishInk}
        onErase={(strokeId) => void classroom.erase(key, strokeId)}
        onPan={host ? (next) => void classroom.command({ type: "zoom", viewport: next }) : undefined}
      />
    </div>
  );

  return (
    <div className={styles.room} data-testid={`room-${identity}`}>
      <aside className={styles.sidebar}>
        <h3 className={styles.sideTitle}>成员 <span>{hostIds.length + memberIds.length}</span></h3>
        <ul className={styles.userList}>
          {[...hostIds, ...memberIds].map((id) => (
            <li key={id} className={styles.userRow}>
              <Avatar person={people[id]} />
              <span className={styles.userName}>{name(id)}{id === identity ? <small>（你）</small> : null}</span>
              {hostIds.includes(id) ? <span className={styles.roleBadge} title="主持人"><PresenterIcon size={13} /> 主持人</span> : null}
              {!hostIds.includes(id) && canMainDraw(id) ? <span className={styles.penBadge} title="可以在课件上书写"><PencilLine size={13} /></span> : null}
              {host && !hostIds.includes(id) && !stage.everyone ? (
                <button type="button" className={styles.miniButton} data-testid={`pen-${id}`} onClick={() => void classroom.command({ type: stage.pens.includes(id) ? "revoke_pen" : "grant_pen", userId: id })}>
                  {stage.pens.includes(id) ? "收回白板权限" : "给白板权限"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {host ? <HostPanel classroom={classroom} memberIds={memberIds} people={people} aspect={aspect} /> : (
          <div className={styles.sideNote}>
            <h3 className={styles.sideTitle}>课堂</h3>
            <p className={styles.note}>{stage.locked ? "白板已锁定。" : stage.work ? "现在是练习时间：在作答板上写出你的答案，主持人能实时看到。" : canMainDraw(identity) ? "你可以在课件上书写，所有人都能看到。" : "跟随主持人观看课件。主持人放大或翻页时，你的画面会同步。"}</p>
          </div>
        )}
      </aside>

      <section className={styles.stageArea} ref={stageArea} data-fullscreen={fullscreen ? "true" : "false"}>
        <header className={styles.stageHead}>
          <h2 title={deckName}>{deckName}</h2>
          <span className={styles.coursePill}>第 {stage.page + 1} / {stage.presentation.pageCount} 页</span>
          {viewport.scale > 1 ? <span className={styles.coursePill}>{Math.round(viewport.scale * 100)}%</span> : null}
          <span className={styles.liveClock} data-connected={classroom.connected ? "true" : "false"}><span className={styles.liveDot} />{classroom.connected ? "直播中" : "连接中…"}</span>
        </header>
        {banner ? <div className={styles.banner} data-tone={banner.tone}>{stage.locked && !host ? <Lock size={14} /> : null}<span>{banner.text}</span>{host && spot ? <button type="button" className={styles.button} onClick={() => void classroom.command({ type: "end_spotlight" })}>结束展示</button> : null}</div> : null}
        <div className={styles.stageBody}>
          <div className={`${styles.boards} ${shown.length > 1 ? styles.boardsSplit : ""}`}>
            {shown.map((item) => boardOf(item.key, { tag: shown.length > 1 || item.accent ? item.tag : undefined, accent: item.accent, testId: `board-${identity}-${item.key}` }))}
          </div>
          {mayDraw ? (
            <WhiteboardTools
              tool={tool}
              onTool={setTool}
              canPan={host && viewport.scale > 1}
              canUndo={(classroom.board(active)?.strokes ?? []).some((stroke) => stroke.authorId === identity)}
              canRedo={classroom.canRedo(active)}
              onUndo={() => classroom.undo(active)}
              onRedo={() => classroom.redo(active)}
              onClear={() => {
                if (host || active === own) void classroom.clear(active);
                else for (const stroke of (classroom.board(active)?.strokes ?? []).filter((item) => item.authorId === identity)) void classroom.erase(active, stroke.id);
              }}
              host={host}
              everyone={stage.everyone}
              onEveryone={(on) => void classroom.command({ type: "everyone", on })}
            />
          ) : null}
          {classroom.toast ? <div className={styles.toast} role="status">{classroom.toast}</div> : null}
        </div>
        <div className={styles.presentationBar}>
          {host ? (
            <>
              <button type="button" className={styles.barButton} aria-label="上一页" disabled={stage.page === 0} onClick={() => void classroom.command({ type: "goto", page: stage.page - 1 })}><ChevronLeft size={18} /></button>
              <select className={styles.pageSelect} aria-label="选择页面" value={stage.page} onChange={(event) => void classroom.command({ type: "goto", page: Number(event.target.value) })} data-testid="page-select">
                {Array.from({ length: stage.presentation.pageCount }, (_, page) => <option key={page} value={page}>第 {page + 1} 页</option>)}
              </select>
              <button type="button" className={styles.barButton} aria-label="下一页" disabled={stage.page >= stage.presentation.pageCount - 1} onClick={() => void classroom.command({ type: "goto", page: stage.page + 1 })}><ChevronRight size={18} /></button>
              <span className={styles.barRule} />
              <button type="button" className={styles.barButton} aria-label="缩小" disabled={viewport.scale <= 1} onClick={() => step(-1)}><ZoomOut size={18} /></button>
              <button type="button" className={styles.zoomValue} aria-label="重置缩放" title="重置缩放" onClick={() => zoom(1)}>{Math.round(viewport.scale * 100)}%</button>
              <button type="button" className={styles.barButton} aria-label="放大" disabled={viewport.scale >= STAGE_LIMITS.maxScale} onClick={() => step(1)} data-testid="zoom-in"><ZoomIn size={18} /></button>
              <button type="button" className={styles.barButton} aria-label="适应页面" title="适应页面" onClick={() => zoom(1)}><ScanSearch size={18} /></button>
            </>
          ) : (
            <span className={styles.barNote}>第 {stage.page + 1} / {stage.presentation.pageCount} 页 · {Math.round(viewport.scale * 100)}% · 跟随主持人</span>
          )}
          <button type="button" className={`${styles.barButton} ${styles.barEnd}`} aria-label={fullscreen ? "退出全屏" : "全屏"} title={fullscreen ? "退出全屏" : "全屏"} onClick={toggleFullscreen}>{fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}</button>
        </div>
        <div className={styles.actionsBar}>
          {host ? (
            <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => { setUploader(true); void classroom.refreshPresentations(); }} data-testid="open-uploader">
              <Plus size={16} /> 上传 / 管理课件
            </button>
          ) : null}
          <span className={styles.mediaNote}>麦克风、摄像头和共享屏幕沿用学习小组房间现有功能</span>
        </div>
      </section>
      {uploader ? <PresentationUploader classroom={classroom} currentId={stage.presentation.id} onClose={() => setUploader(false)} /> : null}
    </div>
  );
}

function HostPanel(props: { classroom: Classroom; memberIds: string[]; people: Record<string, Person>; aspect: number }) {
  const { classroom, memberIds, people } = props;
  const stage = classroom.stage!;
  const at = { presentation: stage.presentation.id, page: stage.page };
  const spot = stage.view.kind === "spotlight" ? stage.view : null;
  return (
    <div className={styles.manage}>
      <h3 className={styles.sideTitle}>白板管理</h3>
      <div className={styles.switchRow}><span>多人白板<small>所有成员都能在课件上书写</small></span><Switch on={stage.everyone} label="多人白板" testId="switch-everyone" onChange={(on) => void classroom.command({ type: "everyone", on })} /></div>
      <div className={styles.switchRow}><span>成员各自作答<small>每人一块作答板，成员之间互相看不到</small></span><Switch on={stage.work} label="成员各自作答" testId="switch-work" onChange={(on) => void classroom.command({ type: "work", on })} /></div>
      <div className={styles.switchRow}><span>锁定成员<small>收起所有成员的画笔和作答板</small></span><Switch on={stage.locked} label="锁定成员" testId="switch-lock" onChange={(on) => void classroom.command({ type: "lock", on })} /></div>
      {stage.work || spot ? (
        <div className={styles.memberBoards}>
          {memberIds.map((id) => {
            const key = boardKey({ owner: id, ...at });
            const strokes = classroom.board(key)?.strokes.length ?? 0;
            const lit = spot?.userId === id;
            return (
              <div key={id} className={styles.memberCard} data-spotlit={lit ? "true" : "false"}>
                <div className={styles.memberHead}><Avatar person={people[id]} /><span>{people[id]?.name ?? id}</span><span className={styles.chip} data-tone={strokes ? "green" : undefined}>{strokes ? `${strokes} 笔` : "还没写"}</span></div>
                <div className={styles.thumb} data-testid={`thumb-${id}`} data-seq={classroom.board(key)?.seq ?? -1}>
                  <BoardCanvas boardKey={key} presentation={stage.presentation.id} page={stage.page} read={classroom.read(stage.presentation.id)} aspect={props.aspect} viewport={FIT_VIEWPORT} board={classroom.board(key)} inks={classroom.inks(key)} />
                </div>
                <div className={styles.memberActions}>
                  {lit && spot?.size === "full" ? <button type="button" className={styles.miniButton} onClick={() => void classroom.command({ type: "spotlight", userId: id, size: "split" })}>缩小并排</button> : <button type="button" className={`${styles.miniButton} ${styles.miniPrimary}`} data-testid={`spot-${id}`} onClick={() => void classroom.command({ type: "spotlight", userId: id, size: "full" })}>放大展示</button>}
                  {lit ? <button type="button" className={styles.miniButton} onClick={() => void classroom.command({ type: "end_spotlight" })}>收回</button> : <button type="button" className={styles.miniButton} data-testid={`split-${id}`} onClick={() => void classroom.command({ type: "spotlight", userId: id, size: "split" })}>并排</button>}
                  <button type="button" className={`${styles.miniButton} ${styles.miniDanger}`} disabled={!strokes} onClick={() => void classroom.clear(key)}>清空</button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
