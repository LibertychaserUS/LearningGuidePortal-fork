// Server-only adapters behind the presentation service's ports (2026-11-02).
//
// - Office documents and images: LibreOffice headless, as BigBlueButton does
//   (OfficeToPdfConversionService). Each run gets its own temporary profile
//   and folder, a time limit and SIGKILL, and runs no macros.
// - Web pages: headless Chromium prints the page to 16:10 PDF pages. Every
//   request the page makes is checked against the address policy, so a
//   redirect or an embedded resource cannot reach the private network.
// - Page count: PDF.js, the same library the browsers render with.
//
// The binaries are runtime dependencies of whichever container runs the
// conversions (LibreOffice, Chromium): an ops item, not shipped by this code.

import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PresentationError, PRESENTATION_LIMITS } from "./presentation";
import type { ConversionInput, HostResolver, PdfInspector, PresentationConverter } from "./presentationService";

export const resolveHost: HostResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);

function run(command: string, args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env: { ...process.env, HOME: tmpdir() } }, (error) => {
      if (!error) return resolve();
      reject((error as { killed?: boolean }).killed ? new PresentationError("conversion_timeout") : error);
    });
  });
}

async function withFolder<T>(work: (folder: string) => Promise<T>) {
  const folder = await mkdtemp(path.join(tmpdir(), "lg-whiteboard-"));
  try {
    return await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export function createOfficeConverter(options: { soffice?: string; timeoutMs?: number } = {}) {
  const soffice = options.soffice ?? process.env.WHITEBOARD_SOFFICE_PATH ?? "soffice";
  const timeoutMs = options.timeoutMs ?? 60_000;
  return (input: { extension: string; bytes: Uint8Array }) => withFolder(async (folder) => {
    // The extension was checked against the file's first bytes (sniffUpload);
    // the name on disk is ours, never the uploader's.
    const source = path.join(folder, `input.${input.extension}`);
    await writeFile(source, input.bytes);
    await run(soffice, ["--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck", `-env:UserInstallation=file://${path.join(folder, "profile")}`, "--convert-to", "pdf", "--outdir", folder, source], timeoutMs);
    try {
      return new Uint8Array(await readFile(path.join(folder, "input.pdf")));
    } catch {
      throw new PresentationError("conversion_failed");
    }
  });
}

type Chromium = { launch: (options?: Record<string, unknown>) => Promise<{ newContext: (options: Record<string, unknown>) => Promise<BrowserContext>; close: () => Promise<void> }> };
type BrowserContext = {
  route: (pattern: string, handler: (route: { request: () => { url: () => string }; continue: () => Promise<void>; abort: () => Promise<void> }) => Promise<void>) => Promise<void>;
  newPage: () => Promise<{
    goto: (url: string, options: Record<string, unknown>) => Promise<{ ok: () => boolean } | null>;
    emulateMedia: (options: Record<string, unknown>) => Promise<void>;
    waitForTimeout: (ms: number) => Promise<void>;
    pdf: (options: Record<string, unknown>) => Promise<Uint8Array>;
  }>;
};

export function createWebConverter(options: { allowed: (url: URL) => Promise<boolean>; loadChromium?: () => Promise<Chromium>; timeoutMs?: number }) {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const loadChromium = options.loadChromium ?? (async () => (await import("playwright")).chromium as unknown as Chromium);
  return async (url: URL) => {
    const executablePath = process.env.WHITEBOARD_CHROMIUM_PATH;
    const browser = await (await loadChromium()).launch(executablePath ? { executablePath } : undefined);
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: "block", bypassCSP: false });
      await context.route("**/*", async (route) => {
        let target: URL;
        try {
          target = new URL(route.request().url());
        } catch {
          return route.abort();
        }
        if (target.protocol === "data:" || target.protocol === "blob:") return route.continue();
        if ((target.protocol === "http:" || target.protocol === "https:") && await options.allowed(target).catch(() => false)) return route.continue();
        return route.abort();
      });
      const page = await context.newPage();
      const response = await page.goto(url.toString(), { waitUntil: "load", timeout: timeoutMs }).catch(() => null);
      if (!response || !response.ok()) throw new PresentationError("unreachable");
      await page.emulateMedia({ media: "screen" });
      await page.waitForTimeout(500);
      return new Uint8Array(await page.pdf({ width: "1280px", height: "800px", printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" }, pageRanges: `1-${PRESENTATION_LIMITS.maxPages}` }));
    } finally {
      await browser.close();
    }
  };
}

export function createConverter(deps: { office: (input: { extension: string; bytes: Uint8Array }) => Promise<Uint8Array>; web: (url: URL) => Promise<Uint8Array> }): PresentationConverter {
  return (input: ConversionInput) => input.source === "web" ? deps.web(input.url) : deps.office(input);
}

export const inspectPdf: PdfInspector = async (pdf) => {
  // Loaded by Node at run time, not bundled: PDF.js sets up its own worker
  // module next to this file.
  const pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs") = await import(/* webpackIgnore: true */ "pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), enableXfa: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const document = await task.promise;
    return { pageCount: document.numPages };
  } catch (error) {
    if ((error as { name?: string }).name === "PasswordException") throw new PresentationError("encrypted");
    throw new Error(`pdf inspect failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await task.destroy();
  }
};
