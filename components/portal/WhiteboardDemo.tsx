"use client";

// Prototype playground for the shared whiteboard (2026-10-29, BigBlueButton
// layout and courseware import 2026-11-02). Each screen is one person's
// browser talking to the real services through the playground API; the
// server pushes the room's packets over Server-Sent Events in LiveKit's
// packet shape. DEV only; no Figma frame yet (待视觉验收); copy not localised.

import { useCallback, useMemo, useState } from "react";
import { DEV_HOSTS, DEV_MEMBERS } from "@/modules/whiteboard/devIdentities";
import { createClassroomClient } from "./whiteboard/api";
import { ClassroomRoom, type Person } from "./whiteboard/ClassroomRoom";
import styles from "./whiteboard/whiteboard.module.css";

const SESSION = "demo-session";
const PEOPLE: Record<string, Person> = {
  host: { name: "Lin", color: "#1d6bff" },
  amy: { name: "Amy", color: "#f79009" },
  ben: { name: "Ben", color: "#12b76a" }
};
const VIEWS = [
  { id: "host", label: "主持人视角" },
  { id: "amy", label: "Amy 视角" },
  { id: "ben", label: "Ben 视角" },
  { id: "all", label: "三屏对照" }
] as const;

export default function WhiteboardDemo({ only }: { only?: string }) {
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("host");
  const [loss, setLoss] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const clients = useMemo(() => Object.fromEntries([...DEV_HOSTS, ...DEV_MEMBERS].map((id) => [id, createClassroomClient(SESSION, id)])), []);
  const onNote = useCallback((line: string) => setLog((lines) => [line, ...lines].slice(0, 8)), []);
  const screens = [...DEV_HOSTS, ...DEV_MEMBERS];

  if (only && clients[only]) {
    return (
      <main className={styles.demo}>
        <ClassroomRoom client={clients[only]} hostIds={DEV_HOSTS} memberIds={DEV_MEMBERS} people={PEOPLE} onNote={onNote} />
      </main>
    );
  }

  return (
    <main className={styles.demo}>
      <div className={styles.demoBar}>
        <h1>共享白板原型</h1>
        <span className={styles.devPill}>DEV · 待视觉验收</span>
        <div className={styles.switcher} role="tablist">
          {VIEWS.map((item) => <button key={item.id} type="button" role="tab" aria-pressed={view === item.id} onClick={() => setView(item.id)}>{item.label}</button>)}
        </div>
        <label className={styles.lossToggle}>
          <input type="checkbox" checked={loss} onChange={(event) => { setLoss(event.target.checked); void clients.host.setLoss(event.target.checked); }} />
          模拟 30% 丢包
        </label>
      </div>
      <div className={`${styles.screens} ${view === "all" ? styles.screensCompare : ""}`}>
        {screens.map((id) => (
          <div key={id} className={styles.screen} data-visible={view === "all" || view === id ? "true" : "false"}>
            {view === "all" ? <p className={styles.screenLabel}>{PEOPLE[id].name}（{DEV_HOSTS.includes(id) ? "主持人" : "成员"}）的屏幕</p> : null}
            <ClassroomRoom client={clients[id]} hostIds={DEV_HOSTS} memberIds={DEV_MEMBERS} people={PEOPLE} onNote={onNote} />
          </div>
        ))}
      </div>
      {log.length ? <ol className={styles.log}>{log.map((line, index) => <li key={index}>{line}</li>)}</ol> : null}
    </main>
  );
}
