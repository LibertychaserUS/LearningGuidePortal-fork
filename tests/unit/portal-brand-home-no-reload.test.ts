import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

// BUG-0328 (1105): on the Portal home page, clicking the Learning Guide brand
// asked the server for the same route again (`/en-GB/portal?_rsc=…`) and reloaded
// the page's CSS and fonts, so the screen flashed. The brand must stay a link
// everywhere else.
test("BUG-0328: the brand link does not navigate again on its own page", async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {PortalHeader} from './components/portal/PortalHeader';const root=createRoot(document.getElementById('root'));window.mount=()=>{flushSync(()=>root.render(<PortalHeader locale="en-GB" active={undefined}/>))};` },
    bundle: true, write: false, outfile: "brand.js", platform: "browser", jsx: "automatic", loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next", setup(builder) {
      builder.onResolve({ filter: /^next\// }, (args) => ({ path: args.path, namespace: "next" }));
      builder.onLoad({ filter: /.*/, namespace: "next" }, (args) => ({ loader: "tsx", resolveDir: process.cwd(), contents: args.path === "next/navigation" ? "const router={refresh(){}};export const useRouter=()=>router;export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search)" : "import React from 'react';export default function Component({prefetch,priority,...props}){return props.src?<img {...props}/>:<a {...props}/>}" }));
    } }],
  });
  const browser = await chromium.launch();
  try {
    async function brandClick(pathname: string) {
      const page = await browser.newPage();
      await page.route("http://brand.test/**", async (route) => {
        if (route.request().url().includes("/api/auth/me")) return route.fulfill({ json: { ok: true, user: null } });
        return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' });
      });
      await page.goto(`http://brand.test${pathname}`);
      await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith("js"))!.text });
      await page.evaluate(() => {
        (window as unknown as { mount: () => void }).mount();
        (window as unknown as { stayed: string }).stayed = "yes";
      });
      await page.locator(".portal-brand").click();
      await page.waitForTimeout(400);
      const stayed = await page.evaluate(() => (window as unknown as { stayed?: string }).stayed ?? "reloaded");
      const url = page.url();
      await page.close();
      return { stayed, url };
    }

    const home = await brandClick("/en-GB/portal");
    assert.equal(home.stayed, "yes", "on the home page the brand does not navigate or reload");
    assert.equal(home.url, "http://brand.test/en-GB/portal");

    const courses = await brandClick("/en-GB/portal/courses");
    assert.equal(courses.stayed, "reloaded", "elsewhere the brand still goes home");
    assert.equal(courses.url, "http://brand.test/en-GB/portal");
  } finally {
    await browser.close();
  }
});
