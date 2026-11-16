import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { applyCourseDraft, deriveLessonVideoDuration, resolveCourseDraftMediaDurations, resolveLessonVideoDurationSeconds } from "../../services/courseAuthoring";
import type { ProductCourse } from "../../services/productStore";
import type { LessonContent } from "../../contracts/lesson-content";
createRequire(import.meta.url).extensions[".css"] = () => {};

// F1: the server must never trust a browser-submitted videoDurationSeconds.
// PRD 12.5.1: "Lesson 时长是上传后从文件读到的实测视频秒数，不接受人工填写"
// (course-duration-consistency.test.ts quotes the SSOT clause). The authoritative
// seconds come from the media asset header, measured at upload time from mvhd
// (services/courseMedia.ts uploadCourseMedia / lib/mediaDuration).

const courseId = "c1";
const media = (assetId: string) => `/api/course-media/${courseId}/${assetId}`;
const video = (id: string, url: string): LessonContent => ({ id, title: "Video", type: "video", mode: "lecture", url, nodes: [] });
const course: ProductCourse = { id: courseId, slug: "s", title: "Course", description: "", categoryKey: null, status: "draft", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sections: [{ id: "s1", title: "One", lessons: [{ id: "l1", title: "Lesson", body: "Text", durationMinutes: 20, isPublic: false }] }] };
const draftOf = (value: ProductCourse) => ({ expectedUpdatedAt: value.updatedAt, title: value.title, description: value.description, sections: structuredClone(value.sections) });
const assetA = "11111111-1111-4111-8111-111111111111";
const assetB = "22222222-2222-4222-8222-222222222222";
const withVideo = (seconds: number, assetId = assetA): ProductCourse => {
  const existing = structuredClone(course);
  const lesson = existing.sections[0].lessons[0];
  lesson.contents = [video("video-group", media(assetId))];
  lesson.videoDurationSeconds = seconds;
  return existing;
};

test("a forged videoDurationSeconds on an unchanged video is ignored, the measured value survives", () => {
  const existing = withVideo(90);
  const draft = draftOf(existing);
  // The client claims 9999 seconds (would show ~167 minutes).
  draft.sections[0].lessons[0].videoDurationSeconds = 9999;
  const saved = applyCourseDraft(existing, draft);
  assert.equal(saved.sections[0].lessons[0].videoDurationSeconds, 90, "the forged seconds must never be stored");
  assert.equal(saved.sections[0].lessons[0].durationMinutes, 2, "minutes follow the measured 90s, not the forged 9999s");
});

test("a forged videoDurationSeconds cannot set minutes on a lesson without media", () => {
  const draft = draftOf(course);
  Object.assign(draft.sections[0].lessons[0], { durationMinutes: 25, videoDurationSeconds: 3300 });
  const saved = applyCourseDraft(course, draft);
  assert.equal(saved.sections[0].lessons[0].videoDurationSeconds, null, "client-submitted seconds are ignored entirely");
  assert.equal(saved.sections[0].lessons[0].durationMinutes, 25, "authored minutes are kept when no measured media exists");
});

test("a swapped video takes the upload-measured value from the asset record, never the submitted one", async () => {
  const existing = withVideo(90, assetA);
  const draft = draftOf(existing);
  draft.sections[0].lessons[0].contents = [video("video-group", media(assetB))];
  draft.sections[0].lessons[0].videoDurationSeconds = 9999; // forged
  const updated = applyCourseDraft(existing, draft);
  assert.notEqual(updated.sections[0].lessons[0].videoDurationSeconds, 9999, "sync pass already ignores the forged value");
  await resolveCourseDraftMediaDurations(updated, draft, async (assetId) => assetId === assetB ? 123 : null);
  assert.equal(updated.sections[0].lessons[0].videoDurationSeconds, 123, "the asset's upload-measured seconds take effect");
  assert.equal(updated.sections[0].lessons[0].durationMinutes, 3, "minutes are re-derived from the measured seconds (ceil 123/60)");
});

test("a legacy external-URL video is not locally measurable: stored seconds are cleared to null", () => {
  const existing = withVideo(90);
  existing.sections[0].lessons[0].contents = [video("video-group", "https://cdn.example.com/v.mp4")];
  const draft = draftOf(existing);
  // Keep the stored external contents: the lesson omits contents so they survive validation.
  delete (draft.sections[0].lessons[0] as { contents?: unknown }).contents;
  draft.sections[0].lessons[0].videoDurationSeconds = 90; // even the old value must not be trusted
  const saved = applyCourseDraft(existing, draft);
  assert.equal(saved.sections[0].lessons[0].videoDurationSeconds, null, "external media is never locally measurable");
});

test("an old S3 seed or unmeasured local asset resolves to null and keeps authored minutes", async () => {
  const existing = withVideo(90, assetA);
  const draft = draftOf(existing);
  const updated = applyCourseDraft(existing, draft);
  await resolveCourseDraftMediaDurations(updated, draft, async () => null);
  assert.equal(updated.sections[0].lessons[0].videoDurationSeconds, null);
  assert.equal(updated.sections[0].lessons[0].durationMinutes, 20, "authored minutes remain without a measured value");
});

test("resolution never reads the asset store for lessons without exactly one active local video", async () => {
  let reads = 0;
  const lookup = async () => { reads++; return 123; };
  const existing = structuredClone(course);
  existing.sections[0].lessons[0].contents = [
    video("first", media(assetA)),
    video("second", media(assetB)),
  ];
  await resolveCourseDraftMediaDurations(existing, draftOf(existing), lookup);
  assert.equal(existing.sections[0].lessons[0].videoDurationSeconds, null, "two different active URLs cannot define one duration");
  const textOnly = structuredClone(course);
  await resolveCourseDraftMediaDurations(textOnly, draftOf(textOnly), lookup);
  assert.equal(textOnly.sections[0].lessons[0].videoDurationSeconds, null);
  assert.equal(reads, 0, "no lookup for ambiguous or missing videos");
});

test("deriveLessonVideoDuration is the neutral sync pass: local+unchanged keeps, local+swapped and external clear", () => {
  const contents = [video("v", media(assetA))];
  assert.equal(deriveLessonVideoDuration(contents, courseId, contents, 90), 90);
  assert.equal(deriveLessonVideoDuration([video("v", media(assetB))], courseId, contents, 90), null);
  assert.equal(deriveLessonVideoDuration([video("v", "https://cdn.example.com/v.mp4")], courseId, contents, 90), null);
  assert.equal(deriveLessonVideoDuration(undefined, courseId, contents, 90), null);
});

test("resolveLessonVideoDurationSeconds returns null outside the measurable window", async () => {
  const contents = [video("v", media(assetA))];
  assert.equal(await resolveLessonVideoDurationSeconds(contents, courseId, async () => 0), null);
  assert.equal(await resolveLessonVideoDurationSeconds(contents, courseId, async () => -5), null);
  assert.equal(await resolveLessonVideoDurationSeconds(contents, courseId, async () => 36001), null);
  assert.equal(await resolveLessonVideoDurationSeconds(contents, courseId, async () => 59.6), 60, "measured seconds are rounded");
  assert.equal(await resolveLessonVideoDurationSeconds([video("v", "https://cdn.example.com/v.mp4")], courseId, async () => 123), null);
});
