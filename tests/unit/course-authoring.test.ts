import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { applyCourseDraft, AuthoringError } from "../../services/courseAuthoring";
import type { ProductCourse } from "../../services/productStore";
import type { LessonContent } from "../../contracts/lesson-content";
createRequire(import.meta.url).extensions[".css"] = () => {};
const course: ProductCourse = { id: "c1", slug: "same-slug", title: "Original", description: "", categoryKey: null, status: "draft", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sections: [{ id: "s1", title: "One", lessons: [{ id: "l1", title: "Lesson", body: "Text", durationMinutes: 20, isPublic: false }] }] };
const input = () => ({ title: "Updated", description: "Updated description", expectedUpdatedAt: course.updatedAt, sections: structuredClone(course.sections) });
test("summary trims, clears, preserves legacy omissions and rejects invalid values", () => {
  const existing = structuredClone(course);
  existing.sections[0].lessons[0].summary = "Existing introduction";
  assert.equal(applyCourseDraft(existing, input()).sections[0].lessons[0].summary, "Existing introduction");
  for (const [value, expected] of [[" New introduction ", "New introduction"], ["", ""]]) {
    const draft = input();
    draft.sections[0].lessons[0].summary = value;
    assert.equal(applyCourseDraft(existing, draft).sections[0].lessons[0].summary, expected);
  }
  for (const value of ["x".repeat(501), null, 123]) {
    const draft = input();
    Object.assign(draft.sections[0].lessons[0], { summary: value });
    assert.throws(() => applyCourseDraft(existing, draft), AuthoringError);
  }
});
test("authoring edits and reorders without changing existing course/lesson IDs", () => {
  const draft = input();
  draft.sections.unshift({ id: "new-section", title: "Two", lessons: draft.sections[0].lessons.splice(0) });
  const result = applyCourseDraft(course, draft);
  assert.equal(result.id, course.id); assert.equal(result.slug, course.slug);
  assert.equal(result.sections[0].lessons[0].id, "l1");
  assert.match(result.sections[0].id, /^section_/);
  assert.equal(course.title, "Original");
  assert.notEqual(result.updatedAt, course.updatedAt);
});
test("published and stale edits are rejected", () => {
  assert.throws(() => applyCourseDraft({ ...course, status: "published" }, input()), (e: unknown) => e instanceof AuthoringError && e.code === "published");
  assert.throws(() => applyCourseDraft(course, { ...input(), expectedUpdatedAt: "old" }), (e: unknown) => e instanceof AuthoringError && e.code === "conflict");
});
test("rejects deleted, duplicate and foreign IDs, invalid durations and multiple public lessons", () => {
  for (const mutate of [
    (d: ReturnType<typeof input>) => { d.sections = []; },
    (d: ReturnType<typeof input>) => { d.sections[0].lessons.push(d.sections[0].lessons[0]); },
    (d: ReturnType<typeof input>) => { d.sections[0].id = "foreign"; },
    (d: ReturnType<typeof input>) => { d.sections[0].lessons[0].durationMinutes = NaN; },
    (d: ReturnType<typeof input>) => { d.sections[0].lessons[0].isPublic = true; d.sections[0].lessons.push({ ...d.sections[0].lessons[0], id: "new-second" }); },
  ]) { const draft = input(); mutate(draft); assert.throws(() => applyCourseDraft(course, draft), AuthoringError); }
});
const videoMedia = (assetId: string) => `/api/course-media/c1/${assetId}`;
const videoLessonContents = (url: string) => [{ id: "video-group", title: "Video", type: "video" as const, mode: "lecture" as const, url, nodes: [] }];
const courseWithVideo = () => {
  const existing = structuredClone(course);
  const lesson = existing.sections[0].lessons[0];
  lesson.contents = videoLessonContents(videoMedia("11111111-1111-4111-8111-111111111111"));
  lesson.videoDurationSeconds = 90;
  return existing;
};
test("omitted video duration is preserved while the active video URL is unchanged", () => {
  assert.equal(applyCourseDraft(courseWithVideo(), input()).sections[0].lessons[0].videoDurationSeconds, 90);
});
test("omitted video duration is cleared when the active video URL changes", () => {
  const draft = input();
  draft.sections[0].lessons[0].contents = videoLessonContents(videoMedia("22222222-2222-4222-8222-222222222222"));
  assert.equal(applyCourseDraft(courseWithVideo(), draft).sections[0].lessons[0].videoDurationSeconds, null);
});
test("measured seconds set the lesson minutes, not the authored estimate", () => {
  const draft = input();
  Object.assign(draft.sections[0].lessons[0], { durationMinutes: 25, videoDurationSeconds: 3300 });
  assert.equal(applyCourseDraft(course, draft).sections[0].lessons[0].durationMinutes, 55);
});
test("measured seconds round up to the next minute", () => {
  const draft = input();
  Object.assign(draft.sections[0].lessons[0], { durationMinutes: 25, videoDurationSeconds: 59 });
  assert.equal(applyCourseDraft(course, draft).sections[0].lessons[0].durationMinutes, 1);
});
test("zero seconds counts as unmeasured and keeps the authored minutes", () => {
  const draft = input();
  Object.assign(draft.sections[0].lessons[0], { durationMinutes: 25, videoDurationSeconds: 0 });
  assert.equal(applyCourseDraft(course, draft).sections[0].lessons[0].durationMinutes, 25);
});
test("without measured video the authored minutes are kept", () => {
  const draft = input();
  draft.sections[0].lessons[0].durationMinutes = 25;
  assert.equal(applyCourseDraft(course, draft).sections[0].lessons[0].durationMinutes, 25);
});
test("durationMinutes validation rejects 0, 601, NaN and non-integers", () => {
  for (const value of [0, 601, NaN, 12.5]) {
    const draft = input();
    draft.sections[0].lessons[0].durationMinutes = value;
    assert.throws(() => applyCourseDraft(course, draft), (e: unknown) => e instanceof AuthoringError && e.code === "invalid");
  }
});
test("seconds beyond the accepted media range are rejected as invalid", () => {
  const draft = input();
  Object.assign(draft.sections[0].lessons[0], { durationMinutes: 25, videoDurationSeconds: 36001 });
  assert.throws(() => applyCourseDraft(course, draft), (e: unknown) => e instanceof AuthoringError && e.code === "invalid");
});
type ContentEditor = typeof import("../../components/portal/LessonContentEditor");
let contentEditor: ContentEditor | undefined;
async function lessonDuration(): Promise<ContentEditor["lessonVideoDuration"]> {
  contentEditor ??= await import("../../components/portal/LessonContentEditor");
  return contentEditor.lessonVideoDuration;
}
const videoPoint = (id: string, url: string, startSeconds = 0): LessonContent => ({ id, title: "Video", type: "video", mode: "lecture", url, startSeconds, nodes: [] });
test("a replacement video the server could not measure saves a null lesson duration", async () => {
  const resolve = await lessonDuration();
  const contents = [videoPoint("video-group", videoMedia("22222222-2222-4222-8222-222222222222"))];
  const draft = input();
  draft.sections[0].lessons[0].contents = contents;
  draft.sections[0].lessons[0].videoDurationSeconds = resolve(contents, new Map([["video-group", null]]), 90);
  assert.equal(applyCourseDraft(courseWithVideo(), draft).sections[0].lessons[0].videoDurationSeconds, null);
});
test("a hand-edited video URL saves a null lesson duration", async () => {
  const resolve = await lessonDuration();
  const contents = [videoPoint("video-group", videoMedia("33333333-3333-4333-8333-333333333333"))];
  const draft = input();
  draft.sections[0].lessons[0].contents = contents;
  draft.sections[0].lessons[0].videoDurationSeconds = resolve(contents, new Map([["video-group", null]]), 90);
  assert.equal(applyCourseDraft(courseWithVideo(), draft).sections[0].lessons[0].videoDurationSeconds, null);
});
test("two different active video URLs cannot define the lesson duration", async () => {
  const resolve = await lessonDuration();
  const contents = [videoPoint("first", videoMedia("11111111-1111-4111-8111-111111111111")), videoPoint("second", videoMedia("44444444-4444-4444-8444-444444444444"))];
  const draft = input();
  draft.sections[0].lessons[0].contents = contents;
  draft.sections[0].lessons[0].videoDurationSeconds = resolve(contents, new Map([["first", 120], ["second", 45]]), 90);
  assert.equal(applyCourseDraft(courseWithVideo(), draft).sections[0].lessons[0].videoDurationSeconds, null);
});
test("two contents on one video URL keep that URL's duration once", async () => {
  const resolve = await lessonDuration();
  const url = videoMedia("11111111-1111-4111-8111-111111111111");
  const contents = [videoPoint("lesson-start", url, 0), videoPoint("chapter-two", url, 600)];
  assert.equal(resolve(contents, new Map([["lesson-start", 90], ["chapter-two", 90]]), 90), 90);
  assert.equal(resolve(contents, new Map(), 90), 90);
});
