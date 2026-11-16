import assert from "node:assert/strict";
import { before, test } from "node:test";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { courseTotalMinutes, totalVideoMinutes } from "../../lib/courseDuration";
import { courseIdentityFrom } from "../../lib/coursePage";
import { courseLessonDuration } from "../../lib/courseDetailPresentation";

// PRD 12.5.1（Course 时长 = 全部 Lesson 时长之和；纯文本课不显示时长）：
// - Lesson 时长是上传后从文件读到的实测视频秒数，不接受编排分钟。
// - 全部 Lesson 都有实测秒数时，Course 时长 = 实测秒数之和（向上取整到分钟）。
// - 没有任何实测秒数可用时，Course 时长不存在，界面不显示任何数字。
// BUG-0348 的"卡片与详情页同源"仍然成立：同一个函数决定两边。
const nodeRequire = createRequire(import.meta.url);
const product = nodeRequire("../../data/knowledge_system/learning_guide/product.json");

type Lesson = { id: string; title: string; isPublic: boolean; durationMinutes?: number; videoDurationSeconds?: number | null };
type Course = { id: string; slug: string; title: string; description: string; status: string; cover?: string | null; thumbnailPath?: string | null; sections: Array<{ lessons: Lesson[] }> };

const productCourse = (id: string): Course => {
  const found = product.courses.find((item: { id: string }) => item.id === id);
  assert.ok(found, `missing product course ${id}`);
  return found;
};
const lessonsOf = (course: Course) => course.sections.flatMap((section) => section.lessons);

let Card: (props: { course: Course; locale: "en-GB" | "zh-CN"; variant?: "catalogue" | "home" }) => ReactNode;

before(async () => {
  const bundle = await build({
    entryPoints: [path.join(process.cwd(), "components/portal/CatalogueCourseCard.tsx")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    tsconfig: path.join(process.cwd(), "tsconfig.json"),
    external: ["react", "react/jsx-runtime", "next/link", "@/components/portal/CourseThumbnail"],
  });
  const stubRequire = (id: string) =>
    id === "@/components/portal/CourseThumbnail"
      ? { CourseThumbnail: () => createElement("img", { alt: "" }) }
      : nodeRequire(id);
  const compiled: { exports: { CatalogueCourseCard: typeof Card } } = { exports: {} as { CatalogueCourseCard: typeof Card } };
  new Function("module", "exports", "require", bundle.outputFiles[0].text)(compiled, compiled.exports, stubRequire);
  Card = compiled.exports.CatalogueCourseCard;
});

test("modeling life has measured video seconds on every lesson and shows 51 minutes", () => {
  const modelingLife = productCourse("modeling-life");
  assert.equal(totalVideoMinutes(lessonsOf(modelingLife)), 51);
  assert.equal(courseTotalMinutes(lessonsOf(modelingLife)), 51);
  assert.equal(courseIdentityFrom(modelingLife).totalMinutes, 51);
});

test("epicureanism, stoicism and quintus have no usable measured video seconds, so the course total is null", () => {
  for (const id of ["epicureanism", "stoicism", "quintus-horatius-flaccus"]) {
    const lessons = lessonsOf(productCourse(id));
    assert.equal(totalVideoMinutes(lessons), null, `${id} must have no measured video total`);
    assert.equal(courseTotalMinutes(lessons), null, `${id} must not fall back to authored minutes`);
    assert.equal(courseIdentityFrom(productCourse(id)).totalMinutes, null, `${id} must not expose a course total`);
  }
  // quintus carries a video that was never measured: still unusable (PRD 12.5.1).
  const quintusLessons = lessonsOf(productCourse("quintus-horatius-flaccus"));
  assert.ok(quintusLessons.some((lesson) => lesson.videoDurationSeconds === null));
});

test("a course with any unmeasured lesson has no course total, even when other lessons carry minutes", () => {
  const mixed = {
    ...productCourse("modeling-life"),
    sections: [{ lessons: [
      { id: "measured", title: "Measured", isPublic: true, durationMinutes: 25, videoDurationSeconds: 1469 },
      { id: "authored-only", title: "Authored only", isPublic: false, durationMinutes: 27 },
    ] }],
  };
  assert.equal(courseTotalMinutes(lessonsOf(mixed)), null);
  assert.equal(courseIdentityFrom(mixed).totalMinutes, null);
});

test("a course with no lessons has no course total", () => {
  const empty = { ...productCourse("epicureanism"), sections: [{ lessons: [] }] };
  assert.equal(courseTotalMinutes(lessonsOf(empty)), null);
});

test("the catalogue card renders the measured total for modeling life", () => {
  const html = renderToStaticMarkup(createElement(Card, { course: productCourse("modeling-life"), locale: "en-GB" }) as any);
  assert.match(html, /2 lessons · 0h 51m/);
});

test("the catalogue card renders no duration at all for courses without measured video", () => {
  for (const id of ["epicureanism", "stoicism", "quintus-horatius-flaccus"]) {
    for (const variant of ["catalogue", "home"] as const) {
      const html = renderToStaticMarkup(createElement(Card, { course: productCourse(id), locale: "en-GB", variant }) as any);
      assert.ok(!/\dh \d+m/.test(html), `${id}/${variant} must not render a duration: ${html}`);
      assert.ok(!html.includes("0h"), `${id}/${variant} must not render a zero placeholder: ${html}`);
      assert.match(html, /2 lessons/, `${id}/${variant} still shows the lesson count: ${html}`);
    }
  }
  const epicureanism = renderToStaticMarkup(createElement(Card, { course: productCourse("epicureanism"), locale: "en-GB" }) as any);
  assert.ok(!epicureanism.includes("45"), "the authored 45 minutes must not leak into the card");
});

test("a lesson without measured seconds shows an em dash, not authored minutes", () => {
  const durationOf = (lesson: Lesson) => courseLessonDuration({
    durationMinutes: lesson.durationMinutes ?? 0,
    videoDurationSeconds: lesson.videoDurationSeconds ?? null,
  });
  const modelingLife = lessonsOf(productCourse("modeling-life"));
  assert.equal(durationOf(modelingLife[0]), "24:29");
  assert.equal(durationOf(lessonsOf(productCourse("epicureanism"))[0]), "—");
  assert.equal(durationOf(lessonsOf(productCourse("stoicism"))[0]), "—");
  assert.equal(durationOf(lessonsOf(productCourse("quintus-horatius-flaccus"))[0]), "—");
});
