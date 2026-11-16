import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CourseDraftInput } from "../../contracts/course-authoring";

// F1 end-to-end through the production save path: uploadCourseMedia measures the file at upload
// time (mvhd) and stores it in the media asset header; saveCourseDraftForOperator must then use
// that measured value and ignore the browser-submitted videoDurationSeconds entirely
// (PRD 12.5.1: "Lesson 时长是上传后从文件读到的实测视频秒数，不接受人工填写").

const cwd = process.cwd();
const oldBackend = process.env.STORAGE_BACKEND, oldOperator = process.env.BACKOFFICE_OPERATOR_EMAIL;
let directory: string;
let store: typeof import("../../services/productStore");
let courseMedia: typeof import("../../services/courseMedia");
let flowerWebm: Buffer;

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

/** A minimal valid mp4 (ftyp + mdat + moov/mvhd) whose mvhd reports the given duration. */
function mp4Bytes(durationSeconds: number): Buffer {
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isomiso2")]));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(durationSeconds * 1000, 16); // duration in timescale units
  const moov = box("moov", box("mvhd", mvhd));
  const mdat = box("mdat", Buffer.from([0]));
  return Buffer.concat([ftyp, mdat, moov]);
}

before(async () => {
  flowerWebm = await readFile(path.join(cwd, "tests/fixtures/media/flower.webm"));
  directory = await mkdtemp(path.join(tmpdir(), "lg-video-trust-")); process.chdir(directory);
  process.env.STORAGE_BACKEND = "local"; process.env.BACKOFFICE_OPERATOR_EMAIL = "operator@example.test";
  store = await import("../../services/productStore");
  courseMedia = await import("../../services/courseMedia");
});

after(async () => {
  process.chdir(cwd);
  if (oldBackend === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = oldBackend;
  if (oldOperator === undefined) delete process.env.BACKOFFICE_OPERATOR_EMAIL; else process.env.BACKOFFICE_OPERATOR_EMAIL = oldOperator;
  await rm(directory, { recursive: true, force: true });
});

async function operatorSession() {
  const operator = await store.registerUser({ email: "operator@example.test", password: "password1", role: "operator" });
  // verifyEmailToken returns the updated (active) user record; the registerUser copy is stale.
  const verified = await store.verifyEmailToken(await store.issueEmailVerificationToken(operator.id));
  const token = (await store.createSession(operator.id)).token;
  return { operator: verified, token };
}

function draftWithVideo(course: Awaited<ReturnType<typeof store.createCourseForOperator>>, url: string): CourseDraftInput {
  return {
    expectedUpdatedAt: course.updatedAt,
    title: course.title,
    description: course.description,
    subtitle: course.subtitle ?? "",
    cover: course.cover ?? course.thumbnailPath ?? null,
    level: course.level ?? "",
    tags: course.tags ?? [],
    referencePrice: course.referencePrice ?? null,
    discount: course.discount ?? null,
    sections: [{ id: "new-section", title: "Section", lessons: [{ id: "new-lesson", title: "Lesson", body: "Lesson body", durationMinutes: 25, videoDurationSeconds: 9999, isPublic: true, contents: [{ id: "video-group", title: "Video", type: "video", mode: "lecture", url, nodes: [] }] }] }],
    removedSectionIds: [],
    removedLessonIds: [],
  };
}

test("the upload-measured mp4 seconds win over a forged draft value on save", async () => {
  const { operator } = await operatorSession();
  const course = await store.createCourseForOperator({ title: "Upload trust test" });
  const asset = await courseMedia.uploadCourseMedia(operator, course.id, { name: "video.mp4", type: "video/mp4", bytes: mp4Bytes(90) });
  assert.equal(asset.durationSeconds, 90, "upload itself reports the measured mvhd seconds");

  const draft = draftWithVideo(course, asset.url);
  const saved = await store.saveCourseDraftForOperator(operator.id, course.id, draft);
  const lesson = saved.sections[0].lessons[0];
  assert.equal(lesson.videoDurationSeconds, 90, "the asset header's measured seconds take effect");
  assert.equal(lesson.durationMinutes, 2, "minutes follow the measured 90s (ceil), not the forged 9999s");
});

test("an upload the server could not measure (webm) saves null and keeps the authored minutes", async () => {
  const { operator } = await operatorSession();
  const course = await store.createCourseForOperator({ title: "Unmeasured upload test" });
  const asset = await courseMedia.uploadCourseMedia(operator, course.id, { name: "flower.webm", type: "video/webm", bytes: flowerWebm });
  assert.equal(asset.durationSeconds, undefined, "webm uploads are never measured");

  const draft = draftWithVideo(course, asset.url);
  const saved = await store.saveCourseDraftForOperator(operator.id, course.id, draft);
  const lesson = saved.sections[0].lessons[0];
  assert.equal(lesson.videoDurationSeconds, null, "no locally measured media means null, never the forged 9999");
  assert.equal(lesson.durationMinutes, 25, "the authored minutes remain without a measured value");
});
