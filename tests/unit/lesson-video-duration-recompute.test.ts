import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { LessonContent } from "../../contracts/lesson-content";

// LessonContentEditor has a side-effect CSS import (see course-authoring.test.ts).
createRequire(import.meta.url).extensions[".css"] = () => {};

const URL_A = "/api/course-media/course-1/aaaaaaaa-1111-4111-8111-111111111111.mp4";
const URL_B = "/api/course-media/course-1/bbbbbbbb-2222-4222-8222-222222222222.mp4";
const video = (id: string, url = URL_A, extra: Partial<LessonContent> = {}): LessonContent => ({ id, title: "Video", type: "video", mode: "lecture", url, nodes: [], ...extra });

test("lesson seconds follow the active video URL set, not the edit that produced it", async () => {
  const { lessonVideoDuration } = await import("../../components/portal/LessonContentEditor");

  // One active video measured at 90s defines the lesson duration.
  assert.equal(lessonVideoDuration([video("v1")], new Map([["v1", 90]]), null), 90);
  // Deleting the only video leaves no active video: the stale seconds must go.
  assert.equal(lessonVideoDuration([], new Map([["v1", 90]]), 90), null);
  // Changing the content type to pdf leaves no active video either.
  assert.equal(lessonVideoDuration([video("v1", URL_A, { type: "pdf", url: undefined })], new Map([["v1", 90]]), 90), null);
  // Deactivating the only video leaves no active video.
  assert.equal(lessonVideoDuration([video("v1", URL_A, { active: false })], new Map([["v1", 90]]), 90), null);
  // Two contents pointing at the same URL are one video, not two (90, not 180).
  assert.equal(lessonVideoDuration([video("v1"), video("v2")], new Map([["v1", 90], ["v2", 90]]), 90), 90);
  // Two different active URLs cannot define a single lesson duration.
  assert.equal(lessonVideoDuration([video("v1"), video("v2", URL_B)], new Map([["v1", 90], ["v2", 45]]), 90), null);
  // With no fresh measurement and an unchanged URL, the stored value is preserved.
  assert.equal(lessonVideoDuration([video("v1")], new Map(), 90), 90);
});

test("editing the contents away from the only video clears the stored lesson seconds", async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { LessonContentEditor } from './components/portal/LessonContentEditor';

        function Harness({ initialContents, initialDuration }) {
          const [contents, setContents] = React.useState(initialContents);
          const [duration, setDuration] = React.useState(initialDuration);
          return <div>
            <output data-testid="duration">{duration === null ? 'null' : String(duration)}</output>
            <LessonContentEditor courseId="course-1" value={contents} locale="en-GB" videoDurationSeconds={duration} onChange={setContents} onVideoDuration={setDuration}/>
          </div>;
        }

        const root = createRoot(document.getElementById('root'));
        window.mount = (props) => flushSync(() => root.render(<Harness key={props.key} initialContents={props.contents} initialDuration={props.duration}/>));
      `,
    },
    bundle: true, write: false, outfile: "lesson-video-duration.js",
    platform: "browser", jsx: "automatic",
    loader: { ".css": "local-css" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "stubs",
      setup(builder) {
        // The duration logic does not depend on the rich editor or the player; stub them so the
        // bundle does not pull tiptap/pdf tooling. CourseMediaPreview resolves next/dynamic lazily.
        builder.onResolve({ filter: /^(next\/dynamic|next\/image|next\/link|next\/navigation)$/ }, args => ({ path: args.path, namespace: "next" }));
        builder.onLoad({ filter: /.*/, namespace: "next" }, args => ({
          resolveDir: process.cwd(), loader: "tsx",
          contents: args.path === "next/dynamic" ? "export default function dynamic(){return () => null}"
            : args.path === "next/navigation" ? "export function useRouter(){return {refresh(){},push(){}}}"
            : "import React from 'react'; export default function Component(props){return props.src ? <img {...props}/> : <a {...props}/>}",
        }));
        builder.onResolve({ filter: /RichLessonEditor$/ }, () => ({ path: "rich", namespace: "stub" }));
        builder.onResolve({ filter: /LessonContentPlayer$/ }, () => ({ path: "player", namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({
          loader: "tsx", resolveDir: process.cwd(),
          contents: args.path === "rich" ? "export function RichLessonEditor(){return null}" : "export function LessonContentPlayer(){return null}",
        }));
      },
    }],
  });
  const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on("dialog", dialog => void dialog.accept());
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const read = () => page.locator("[data-testid=duration]").textContent();
    const mount = (key: string, contents: LessonContent[], duration: number | null) =>
      page.evaluate(args => (window as unknown as { mount: (p: unknown) => void }).mount(args), { key, contents, duration });
    const field = (selector: string) => page.locator(selector);
    const title = () => field(".la-content-group .la-heading label input").first();

    await mount("delete", [video("v1")], 90);
    assert.equal(await read(), "90", "seeded lesson starts with its stored seconds");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    assert.equal(await read(), "null", "deleting the only video clears the stored lesson seconds");

    await mount("type", [video("v1")], 90);
    assert.equal(await read(), "90");
    await field(".la-columns select").first().selectOption("pdf");
    assert.equal(await read(), "null", "changing the only video to a pdf clears the stored lesson seconds");

    await mount("active", [video("v1")], 90);
    assert.equal(await read(), "90");
    await field('.la-check input[type="checkbox"]').first().uncheck();
    assert.equal(await read(), "null", "deactivating the only video clears the stored lesson seconds");

    // Editing content that does not change the active video URL must keep the stored value
    // (loaded from the server with no in-editor measurement).
    await mount("title", [video("v1")], 90);
    assert.equal(await read(), "90");
    await title().fill("Renamed video");
    assert.equal(await read(), "90", "an unrelated edit keeps the stored lesson seconds");
  } finally {
    await browser.close();
  }
});
