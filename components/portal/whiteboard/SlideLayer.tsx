"use client";

// The courseware page under a board: page n of the presentation's PDF,
// rendered by PDF.js in this browser. Every browser renders the same PDF the
// server converted, so the slides look the same everywhere. "blank" is the
// empty 16:9 whiteboard.

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import styles from "./whiteboard.module.css";

const WORKER = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export const BLANK_ASPECT = 9 / 16;
const MAX_CANVAS_PIXELS = 12 * 1024 * 1024;

const documents = new Map<string, Promise<PDFDocumentProxy>>();

// One PDF.js document per presentation, shared by every board, thumbnail and
// screen on the page.
export function loadDeck(id: string, read: () => Promise<Uint8Array>) {
  let task = documents.get(id);
  if (!task) {
    // PDF.js loads in the browser only, never during server rendering.
    task = Promise.all([read(), import("pdfjs-dist")]).then(([data, pdfjs]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = WORKER;
      return pdfjs.getDocument({ data, enableXfa: false, useSystemFonts: true, useWasm: false, maxImageSize: 16 * 1024 * 1024, canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4 }).promise;
    });
    task.catch(() => documents.delete(id));
    documents.set(id, task);
  }
  return task;
}

const aspects = new Map<string, number>();

// Height / width of a page, known once the page was opened.
export function knownAspect(presentation: string, page: number) {
  return presentation === "blank" ? BLANK_ASPECT : aspects.get(`${presentation}/${page}`);
}

export function SlideLayer(props: { presentation: string; page: number; read: () => Promise<Uint8Array>; pixelWidth: number; onAspect?: (aspect: number) => void; label?: string }) {
  const { presentation, page, read, pixelWidth, onAspect } = props;
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">(presentation === "blank" ? "ready" : "loading");

  useEffect(() => {
    if (presentation === "blank") {
      onAspect?.(BLANK_ASPECT);
      setState("ready");
      return;
    }
    let cancelled = false;
    let render: RenderTask | null = null;
    setState("loading");
    loadDeck(presentation, read).then(async (deck) => {
      const pdfPage = await deck.getPage(page + 1);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const aspect = base.height / base.width;
      aspects.set(`${presentation}/${page}`, aspect);
      onAspect?.(aspect);
      const width = Math.max(64, Math.min(pixelWidth, Math.floor(Math.sqrt(MAX_CANVAS_PIXELS / aspect))));
      const viewport = pdfPage.getViewport({ scale: width / base.width });
      const target = canvas.current;
      if (!target) return;
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      render = pdfPage.render({ canvas: target, viewport });
      await render.promise;
      if (!cancelled) setState("ready");
    }).catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; render?.cancel(); };
    // read is stable per client; re-render on deck, page or resolution changes.
  }, [presentation, page, pixelWidth]);

  return (
    <div className={styles.slideLayer} data-state={state} aria-label={props.label}>
      {presentation === "blank" ? null : <canvas ref={canvas} />}
      {state === "loading" ? <span className={styles.slideNote}>正在加载课件…</span> : null}
      {state === "error" ? <span className={styles.slideNote}>课件加载失败</span> : null}
    </div>
  );
}
