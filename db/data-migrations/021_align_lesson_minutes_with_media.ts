import type { ProductCourse } from "../../services/productStore";
import type { MigrationOrm } from "../../services/migrationOrm";
import { lessonMinutesFromMedia } from "../../lib/courseDuration";
import type { DataChange, DataMigrationContext } from "./types";

export const id = "021_align_lesson_minutes_with_media";
export const description =
  "BUG-0348: give every Lesson that has a measured video duration the same minutes the player reports (ceil seconds/60), so authored minutes never contradict the media.";
export const touches = ["courses"] as const;

/**
 * 媒体时长是唯一真源：Admin 上传后自动读取，不接受手填。
 * 这条迁移只修“有媒体、但分钟数是旧的/手填的”课时；没有媒体的课时保持原样。
 * 幂等：已经一致的课时不产生变更。
 */
export function apply(orm: MigrationOrm, ctx: DataMigrationContext): DataChange[] {
  const courses = orm.table<ProductCourse>("courses");
  const changes: DataChange[] = [];

  for (const course of courses.all()) {
    let touched = false;
    const sections = course.sections.map((section) => ({
      ...section,
      lessons: section.lessons.map((lesson) => {
        const minutes = lessonMinutesFromMedia(lesson.videoDurationSeconds);
        if (minutes === null || minutes === lesson.durationMinutes) return lesson;
        touched = true;
        changes.push({
          action: "update",
          kind: "lesson",
          id: lesson.id,
          reason: `duration:${lesson.durationMinutes}->${minutes}`,
        });
        return { ...lesson, durationMinutes: minutes };
      }),
    }));

    if (touched) {
      courses.update(course.id, {
        sections,
        updatedAt: new Date(
          Math.max(Date.parse(ctx.now), Date.parse(course.updatedAt) + 1),
        ).toISOString(),
      });
    }
  }

  return changes.length
    ? changes
    : [{ action: "skip", kind: "lesson", id: "all", reason: "no-measured-media-mismatch" }];
}
