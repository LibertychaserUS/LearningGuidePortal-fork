type LessonDuration = { videoDurationSeconds?: number | null };
type LessonWithMinutes = LessonDuration & { durationMinutes?: number };

export function totalVideoMinutes(lessons: LessonDuration[]): number | null {
  if (!lessons.length || lessons.some(lesson => typeof lesson.videoDurationSeconds !== "number" || !Number.isFinite(lesson.videoDurationSeconds) || lesson.videoDurationSeconds < 0)) return null;
  return Math.ceil(lessons.reduce((total, lesson) => total + lesson.videoDurationSeconds!, 0) / 60);
}

/**
 * BUG-0348 的数据规则：有实测媒体时，课时分钟数由媒体算出，不接受手填。
 * Admin 上传后自动读时长（CourseContentSection: "no manual entry"），这里把它落成不变式。
 */
export function lessonMinutesFromMedia(seconds?: number | null): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds / 60)
    : null;
}

/**
 * BUG-0348：课程总时长的唯一计算源。
 *
 * 目录卡片、课程详情页与学习概览都从这里取数：有实测媒体时长时用实测
 * （向上取整到分钟），否则退回编排分钟。三个页面显示同一个数字。
 */
export function courseTotalMinutes(lessons: LessonWithMinutes[]): number {
  return (
    totalVideoMinutes(lessons) ??
    lessons.reduce((total, lesson) => total + (lesson.durationMinutes || 0), 0)
  );
}
