import { randomUUID } from "node:crypto";
import type { CourseDraftInput, CourseMetadata, CourseListQuery } from "@/contracts/course-authoring";
import type { LessonContent } from "@/contracts/lesson-content";
import type { ProductCourse, ProductUser, ProductSection } from "@/services/productStore";
import { canManageCourse } from "./backofficeAccess";
import { validateLessonContents, lessonContentsText, courseMediaAssetId } from "./lessonContent";
import { lessonMinutesFromMedia } from "@/lib/courseDuration";

export class AuthoringError extends Error {
  constructor(public code: "invalid" | "conflict" | "published" | "restricted" | "notFound" | "inUse" | "archived") { super(code); }
}

export function validateCourseMetadata(input: CourseMetadata, courseId?: string): CourseMetadata {
  const output: CourseMetadata = {};
  if (input.subtitle !== undefined) output.subtitle = text(input.subtitle, 255, false);
  if (input.level !== undefined) {
    if (!["", "beginner", "intermediate", "advanced"].includes(input.level)) throw new AuthoringError("invalid");
    output.level = input.level;
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 30) throw new AuthoringError("invalid");
    output.tags = [...new Set(input.tags.map(tag => text(tag, 60)))];
  }
  for (const key of ["outcomes", "features"] as const) if (input[key] !== undefined) {
    if (!Array.isArray(input[key]) || input[key]!.length > 30) throw new AuthoringError("invalid");
    output[key] = input[key]!.map(value => text(value, 1000));
  }
  for (const key of ["categoryId", "subjectId"] as const) if (input[key] !== undefined) output[key] = input[key] === null ? null : text(input[key], 200);
  if (input.cover !== undefined) {
    const cover = input.cover === null ? null : text(input.cover, 2048, false);
    if (cover && (/[\\\s]/.test(cover) || !(cover.startsWith("/") && !cover.startsWith("//") || (() => { try { return new URL(cover).protocol === "https:"; } catch { return false; } })()))) throw new AuthoringError("invalid");
    if (cover && /\/api\/course-media/i.test(cover) && (!courseId || !courseMediaAssetId(cover, courseId))) throw new AuthoringError("invalid");
    output.cover = cover;
  }
  for (const key of ["referencePrice", "discount"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > (key === "discount" ? 100 : 99999999) || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001)) throw new AuthoringError("invalid");
    output[key] = value;
  }
  return output;
}

export function selectAuthorCourses(courses: ProductCourse[], user: ProductUser, query: CourseListQuery = {}) {
  const owned = courses.filter(course => canManageCourse(user, course));
  const search = (query.search || "").trim().toLocaleLowerCase();
  if (search.length > 200) throw new AuthoringError("invalid");
  const pageSize = query.pageSize ?? 10, requestedPage = query.page ?? 1;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(requestedPage) || requestedPage < 1 || (query.status && !["all", "draft", "published", "archived"].includes(query.status))) throw new AuthoringError("invalid");
  const matches = owned.filter(course => (query.status === "all" || (query.status ? course.status === query.status : course.status !== "archived")) && (!query.categoryId || course.categoryKey === query.categoryId) && (!query.level || course.level === query.level) && (!search || [course.title, course.subtitle, course.description, ...(course.tags || []), ...course.sections.flatMap(s => [s.title, ...s.lessons.map(l => `${l.title} ${l.body}`)])].join(" ").toLocaleLowerCase().includes(search)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const total = matches.length, pages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(requestedPage, pages);
  return { courses: matches.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pages, counts: { total: owned.length, draft: owned.filter(c => c.status === "draft").length, published: owned.filter(c => c.status === "published").length, archived: owned.filter(c => c.status === "archived").length, lessons: owned.filter(c => c.status !== "archived").reduce((sum, c) => sum + c.sections.reduce((n, s) => n + s.lessons.length, 0), 0) } };
}
function text(value: unknown, max: number, required = true): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new AuthoringError("invalid");
  return value.trim();
}

// Apply to the current aggregate inside its transaction, never to a browser snapshot.
export function applyCourseDraft(course: ProductCourse, input: CourseDraftInput): ProductCourse {
  if (course.status !== "draft") throw new AuthoringError(course.status === "archived" ? "archived" : "published");
  if (input.expectedUpdatedAt !== course.updatedAt) throw new AuthoringError("conflict");
  if (!Array.isArray(input.sections) || input.sections.length > 100) throw new AuthoringError("invalid");
  const sectionIds = new Set(course.sections.map(section => section.id));
  const existingLessons = new Map(course.sections.flatMap(section => section.lessons.map(lesson => [lesson.id, lesson] as const)));
  const seen = new Set<string>();
  let publicCount = 0, lessonCount = 0;
  function identity(value: unknown, existing: Set<string> | Map<string, unknown>, kind: string) {
    const key = text(value, 200);
    if (seen.has(key) || (!existing.has(key) && !/^new-[a-z0-9-]+$/i.test(key))) throw new AuthoringError("invalid");
    seen.add(key);
    return existing.has(key) ? key : `${kind}_${randomUUID()}`;
  }
  const sections = input.sections.map(section => {
    if (!section || !Array.isArray(section.lessons)) throw new AuthoringError("invalid");
    return { id: identity(section.id, sectionIds, "section"), title: text(section.title, 255), lessons: section.lessons.map(lesson => {
      if (!lesson || ++lessonCount > 1000 || !Number.isInteger(lesson.durationMinutes) || lesson.durationMinutes < 1 || lesson.durationMinutes > 600 || typeof lesson.isPublic !== "boolean") throw new AuthoringError("invalid");
      // PRD 12.5.1 (F1): lesson.videoDurationSeconds is untrusted browser input and is never read.
      if (lesson.isPublic && (++publicCount > 1 || lessonCount !== 1)) throw new AuthoringError("invalid");
      const existing = existingLessons.get(lesson.id);
      let contents = existing?.contents;
      if (lesson.contents !== undefined) {
        try { contents = validateLessonContents(lesson.contents, course.id); } catch { throw new AuthoringError("invalid"); }
      }
      // Rich contents are authoritative. Legacy clients cannot silently flatten them.
      const body = contents?.length ? lessonContentsText(contents).slice(0, 200000) : text(lesson.body, 200000, false);
      // PRD 12.5.1 (F1): the browser-submitted videoDurationSeconds is ignored. The neutral sync
      // pass keeps a previously measured value only while the single active local video is
      // unchanged; resolveCourseDraftMediaDurations then replaces it with the authoritative
      // asset-header value (measured at upload from mvhd) or null.
      const videoDurationSeconds = deriveLessonVideoDuration(contents ?? existing?.contents, course.id, existing?.contents, existing?.videoDurationSeconds ?? null);
      // 有实测媒体时分钟数由媒体算出；没有实测秒数才退回编排分钟。
      const durationMinutes = lessonMinutesFromMedia(videoDurationSeconds) ?? lesson.durationMinutes;
      return { ...existing, id: identity(lesson.id, existingLessons, "lesson"), title: text(lesson.title, 255), summary: lesson.summary === undefined ? existing?.summary || "" : text(lesson.summary, 500, false), body, ...(contents !== undefined ? { contents } : {}), durationMinutes, videoDurationSeconds, isPublic: lesson.isPublic };
    }) };
  });
  const removedSections = input.removedSectionIds ?? [], removedLessons = input.removedLessonIds ?? [];
  if (!Array.isArray(removedSections) || !Array.isArray(removedLessons) || removedSections.some(id => !sectionIds.has(id) || seen.has(id)) || removedLessons.some(id => !existingLessons.has(id) || seen.has(id))) throw new AuthoringError("invalid");
  const archived: ProductSection[] = [];
  for (const section of course.sections) {
    const missing = section.lessons.filter(lesson => !seen.has(lesson.id));
    if (missing.some(lesson => !removedLessons.includes(lesson.id) && !removedSections.includes(section.id))) throw new AuthoringError("invalid");
    if (!seen.has(section.id) && !removedSections.includes(section.id)) throw new AuthoringError("invalid");
    if (missing.length || removedSections.includes(section.id)) archived.push({ ...section, lessons: structuredClone(missing), archivedAt: new Date().toISOString() });
  }
  return { ...course, ...validateCourseMetadata(input, course.id), title: text(input.title, 255), description: text(input.description, 5000, false), sections,
    ...(input.cover !== undefined ? { thumbnailPath: input.cover || null } : {}),
    archivedSections: [...(course.archivedSections || []), ...archived],
    updatedAt: new Date(Math.max(Date.now(), Date.parse(course.updatedAt) + 1)).toISOString() };
}

/** The active video URLs of a lesson's rich contents: the only source a lesson duration may come from. */
export function lessonVideoUrls(contents: LessonContent[] | undefined): Set<string> {
  const urls = new Set<string>();
  for (const content of contents ?? []) if (content.type === "video" && content.active !== false && content.url) urls.add(content.url);
  return urls;
}

/**
 * PRD 12.5.1 / F1: neutral sync pass for the lesson seconds, run inside applyCourseDraft.
 * The previous value survives only while the single active video is an unchanged local
 * course-media asset; external URLs, old S3 seeds, swapped, ambiguous or absent videos
 * clear it to null. The browser-submitted videoDurationSeconds is never read.
 */
export function deriveLessonVideoDuration(contents: LessonContent[] | undefined, courseId: string, existingContents: LessonContent[] | undefined, previous: number | null): number | null {
  const urls = lessonVideoUrls(contents);
  if (urls.size !== 1) return null;
  const url = [...urls][0];
  if (!courseMediaAssetId(url, courseId)) return null;
  const prior = lessonVideoUrls(existingContents);
  return prior.size === 1 && prior.has(url) ? previous : null;
}

export type VideoSecondsLookup = (assetId: string) => Promise<number | null>;

/**
 * PRD 12.5.1 / F1: authoritative save-time resolution. Only a single active video that is a
 * local course-media asset is measurable: its upload-time mvhd value lives in the media asset
 * header. External URLs, old S3 seeds, unmeasured uploads and ambiguous videos resolve to null.
 */
export async function resolveLessonVideoDurationSeconds(contents: LessonContent[] | undefined, courseId: string, lookup: VideoSecondsLookup): Promise<number | null> {
  const urls = lessonVideoUrls(contents);
  if (urls.size !== 1) return null;
  const assetId = courseMediaAssetId([...urls][0], courseId);
  if (!assetId) return null;
  const seconds = await lookup(assetId);
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= 36000 ? Math.round(seconds) : null;
}

/**
 * PRD 12.5.1 / F1: after applyCourseDraft, overwrite every lesson's seconds with the measured
 * asset value (or null) and re-derive the minutes from the measured media. Minutes fall back to
 * the authored draft minutes when nothing is measured. Must run inside the save transaction so
 * the persisted aggregate never contains a browser-supplied duration.
 */
export async function resolveCourseDraftMediaDurations(course: ProductCourse, input: CourseDraftInput, lookup: VideoSecondsLookup): Promise<ProductCourse> {
  const authoredMinutes = new Map<string, number>();
  for (const section of input.sections) for (const lesson of section.lessons) authoredMinutes.set(lesson.id, lesson.durationMinutes);
  for (const section of course.sections) for (const lesson of section.lessons) {
    const seconds = await resolveLessonVideoDurationSeconds(lesson.contents, course.id, lookup);
    lesson.videoDurationSeconds = seconds;
    lesson.durationMinutes = lessonMinutesFromMedia(seconds) ?? authoredMinutes.get(lesson.id) ?? lesson.durationMinutes;
  }
  return course;
}

/** Production lookup: the upload-measured seconds stored in the media asset container header. */
export async function storedAssetVideoSeconds(courseId: string): Promise<VideoSecondsLookup> {
  const { readStoredAssetRange } = await import("./courseMedia");
  return async (assetId: string) => {
    try {
      // A one-byte range reads the container header (and nothing else) and returns the stored
      // CourseMediaAsset metadata, including the upload-time mvhd measurement when it exists.
      const { asset } = await readStoredAssetRange(courseId, assetId, 0, 0);
      const seconds = asset.durationSeconds;
      return typeof seconds === "number" && seconds > 0 ? seconds : null;
    } catch { return null; }
  };
}
