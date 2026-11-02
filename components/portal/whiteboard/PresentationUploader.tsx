"use client";

// Courseware manager, after BigBlueButton's "Upload/Manage presentations":
// drop or browse files, import a web page, watch upload and conversion
// progress, preview the pages, pick the current deck and confirm. Only the
// host opens it. Conversion runs on the server; the list updates from the
// server's progress messages.

import { useRef, useState } from "react";
import { FileText, Globe, Image as ImageIcon, Presentation as SlidesIcon, Trash2, Upload, X } from "lucide-react";
import { ACCEPTED_EXTENSIONS, PRESENTATION_LIMITS, type Presentation } from "@/modules/whiteboard/presentation";
import { BLANK_PRESENTATION } from "@/modules/whiteboard/stage";
import { SlideLayer } from "./SlideLayer";
import type { Classroom } from "./useClassroom";
import styles from "./whiteboard.module.css";

const ERRORS: Record<string, string> = {
  too_large: `文件超过 ${PRESENTATION_LIMITS.maxBytes / 1024 / 1024} MB`,
  unsupported: "不支持这种文件，请上传 PDF、PPT、Word 或图片",
  empty: "文件是空的",
  page_count_exceeded: `超过 ${PRESENTATION_LIMITS.maxPages} 页`,
  conversion_failed: "转换失败，请另存为 PDF 后再上传",
  conversion_timeout: "转换超时，请另存为 PDF 后再上传",
  encrypted: "文件有密码保护，请去掉密码后再上传",
  blocked_url: "这个网址不能导入（只支持公开网页）",
  unreachable: "打不开这个网页",
  too_many: `每场最多 ${PRESENTATION_LIMITS.perSession} 份课件`,
  in_use: "正在展示的课件不能删除",
  forbidden: "只有主持人可以管理课件",
  network_error: "网络中断，请重试"
};

const SOURCE: Record<Presentation["source"], { label: string; icon: typeof FileText }> = {
  pdf: { label: "PDF", icon: FileText },
  office: { label: "PPT/Word", icon: SlidesIcon },
  image: { label: "图片", icon: ImageIcon },
  web: { label: "网页", icon: Globe }
};

type Upload = { key: string; name: string; percent: number; error?: string };

export function PresentationUploader(props: { classroom: Classroom; currentId: string; onClose: () => void }) {
  const { classroom } = props;
  const [selected, setSelected] = useState(props.currentId);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const decks = classroom.presentations;
  const chosen = decks.find((item) => item.id === selected);

  const send = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Date.now()}`;
      if (file.size > PRESENTATION_LIMITS.maxBytes) {
        setUploads((list) => [...list, { key, name: file.name, percent: 0, error: ERRORS.too_large }]);
        continue;
      }
      setUploads((list) => [...list, { key, name: file.name, percent: 0 }]);
      classroom.upload(file, (percent) => setUploads((list) => list.map((item) => (item.key === key ? { ...item, percent } : item))))
        .then((created) => {
          setUploads((list) => list.filter((item) => item.key !== key));
          setSelected((current) => (current === props.currentId ? created.id : current));
        })
        .catch((error: { code?: string }) => setUploads((list) => list.map((item) => (item.key === key ? { ...item, error: ERRORS[error.code ?? ""] ?? ERRORS.network_error } : item))));
    }
  };

  const importWeb = async () => {
    setUrlError("");
    try {
      const created = await classroom.importWeb(url);
      setUrl("");
      setSelected(created.id);
    } catch (error) {
      setUrlError(ERRORS[(error as { code?: string }).code ?? ""] ?? ERRORS.network_error);
    }
  };

  const status = (item: Presentation) => {
    if (item.status === "ready") return <span className={styles.chip} data-tone="green">就绪 · {item.pageCount} 页</span>;
    if (item.status === "failed") return <span className={styles.chip} data-tone="red">{ERRORS[item.error ?? ""] ?? "失败"}</span>;
    return <span className={styles.chip} data-tone="blue"><span className={styles.spinner} />{item.source === "web" ? "正在抓取网页…" : item.source === "pdf" ? "正在检查文件…" : "正在服务器上转换…"}</span>;
  };

  const confirm = async () => {
    if (selected !== props.currentId) await classroom.command({ type: "present", presentationId: selected });
    props.onClose();
  };

  return (
    <div className={styles.modalBackdrop} role="presentation" onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="uploader-title" data-testid="presentation-uploader">
        <header className={styles.modalHead}>
          <h2 id="uploader-title">课件</h2>
          <div className={styles.modalActions}>
            <button type="button" className={styles.button} onClick={props.onClose}>取消</button>
            <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={selected !== BLANK_PRESENTATION.id && chosen?.status !== "ready"} onClick={() => void confirm()} data-testid="uploader-confirm">确认</button>
          </div>
        </header>
        <p className={styles.modalText}>作为主持人，你可以上传 PDF、PPT/PPTX、Word 文档或图片，也可以导入一个网页。文件在服务器上统一转成 PDF，所有人看到的版式完全一样。<strong>要保证版式和原 PPT 完全一致，请先在 PowerPoint 或 Keynote 里另存为 PDF 再上传。</strong>动画和视频不会保留。</p>
        <p className={styles.modalHint}>每个文件不超过 {PRESENTATION_LIMITS.maxBytes / 1024 / 1024} MB、{PRESENTATION_LIMITS.maxPages} 页。选中左侧圆圈的课件，点“确认”后展示给所有人。</p>

        <div className={styles.deckTable} role="radiogroup" aria-label="课件列表">
          <div className={styles.deckRow} data-head="true"><span>当前</span><span>文件名</span><span>状态</span><span /></div>
          <label className={styles.deckRow}>
            <input type="radio" name="deck" checked={selected === BLANK_PRESENTATION.id} onChange={() => setSelected(BLANK_PRESENTATION.id)} />
            <span className={styles.deckName}><FileText size={15} /> 空白白板</span>
            <span>{props.currentId === BLANK_PRESENTATION.id ? <span className={styles.chip} data-tone="blue">正在展示</span> : null}</span>
            <span />
          </label>
          {decks.map((item) => {
            const Icon = SOURCE[item.source].icon;
            return (
              <label key={item.id} className={styles.deckRow} data-testid={`deck-${item.source}`} data-status={item.status}>
                <input type="radio" name="deck" disabled={item.status !== "ready"} checked={selected === item.id} onChange={() => setSelected(item.id)} />
                <span className={styles.deckName} title={item.origin}><Icon size={15} /> {item.name} <small>{SOURCE[item.source].label}</small></span>
                <span>{item.id === props.currentId ? <span className={styles.chip} data-tone="blue">正在展示</span> : status(item)}</span>
                <span>
                  {item.id === props.currentId ? null : (
                    <button type="button" className={styles.iconButton} aria-label={`删除 ${item.name}`} title="删除" onClick={(event) => { event.preventDefault(); void classroom.removePresentation(item.id); if (selected === item.id) setSelected(props.currentId); }}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </span>
              </label>
            );
          })}
          {uploads.map((item) => (
            <div key={item.key} className={styles.deckRow}>
              <span />
              <span className={styles.deckName}><Upload size={15} /> {item.name}</span>
              <span>{item.error ? <span className={styles.chip} data-tone="red">{item.error}</span> : <span className={styles.progress}><span style={{ width: `${item.percent}%` }} /><em>上传中 {item.percent}%</em></span>}</span>
              <span>{item.error ? <button type="button" className={styles.iconButton} aria-label="移除" onClick={() => setUploads((list) => list.filter((entry) => entry.key !== item.key))}><X size={15} /></button> : null}</span>
            </div>
          ))}
        </div>

        {chosen?.status === "ready" ? (
          <div className={styles.previewStrip} aria-label="页面预览">
            <p className={styles.modalHint}>预览：{chosen.name}（共 {chosen.pageCount} 页，确认版式无误后再展示）</p>
            <div className={styles.previewPages}>
              {Array.from({ length: Math.min(chosen.pageCount, 6) }, (_, page) => (
                <div key={page} className={styles.previewPage}>
                  <SlideLayer presentation={chosen.id} page={page} read={classroom.read(chosen.id)} pixelWidth={360} label={`第 ${page + 1} 页`} />
                  <span>{page + 1}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div
          className={styles.dropzone}
          data-dragging={dragging ? "true" : "false"}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); send(event.dataTransfer.files); }}
        >
          <Upload size={22} />
          <span>把文件拖到这里上传</span>
          <button type="button" className={styles.linkButton} onClick={() => input.current?.click()}>或浏览文件</button>
          <input ref={input} type="file" multiple hidden accept={ACCEPTED_EXTENSIONS.map((item) => `.${item}`).join(",")} data-testid="uploader-file" onChange={(event) => { if (event.target.files) send(event.target.files); event.target.value = ""; }} />
        </div>

        <form className={styles.webImport} onSubmit={(event) => { event.preventDefault(); void importWeb(); }}>
          <Globe size={16} />
          <input type="url" value={url} placeholder="导入网页：粘贴网址，转成静态页面" aria-label="网页地址" onChange={(event) => setUrl(event.target.value)} data-testid="uploader-url" />
          <button type="submit" className={styles.button} disabled={!url.trim()}>导入</button>
        </form>
        {urlError ? <p className={styles.formError}>{urlError}</p> : null}
      </div>
    </div>
  );
}
