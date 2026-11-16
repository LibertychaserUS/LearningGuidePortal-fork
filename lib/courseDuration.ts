type LessonDuration = { videoDurationSeconds?: number | null };
type LessonWithMinutes = LessonDuration & { durationMinutes?: number };

export function totalVideoMinutes(lessons: LessonDuration[]): number | null {
  if (!lessons.length || lessons.some(lesson => typeof lesson.videoDurationSeconds !== "number" || !Number.isFinite(lesson.videoDurationSeconds) || lesson.videoDurationSeconds <= 0)) return null;
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
 * BUG-0348 / PRD 12.5.1：课程总时长的唯一计算源。
 *
 * 目录卡片、课程详情页与学习概览都从这里取数：只有全部 Lesson 都有实测视频
 * 秒数时才给出总分钟（向上取整）。纯文本课、或有 Lesson 未测到时长时返回
 * null —— 表示"不显示时长"，绝不退回编排分钟，也不显示 0。
 */
export function courseTotalMinutes(lessons: LessonWithMinutes[]): number | null {
  return totalVideoMinutes(lessons);
}
