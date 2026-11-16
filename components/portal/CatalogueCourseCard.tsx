import Link from "next/link";
import { CourseThumbnail } from "@/components/portal/CourseThumbnail";
import { courseTotalMinutes } from "@/lib/courseDuration";
import { getMessages } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/i18n/config";
import type { ProductCourse } from "@/services/productStore";

/** P4: `category` is the Admin-localized display name; unclassified courses render no badge. */
export function CatalogueCourseCard({ course, category, locale, variant = "catalogue" }: { course: ProductCourse; category?: string | null; locale: Locale; variant?: "catalogue" | "home" }) {
  const copy = getMessages(locale).portal;
  const lessons = course.sections.flatMap(section => section.lessons);
  const minutes = courseTotalMinutes(lessons);
  const homeCopy = getMessages(locale).homeDesign;
  // PRD 12.5.1: a course without measured video renders no duration at all — no zero, no placeholder.
  const duration = minutes === null ? null : `${Math.floor(minutes / 60)}${homeCopy.hourShort} ${minutes % 60}${homeCopy.minuteShort}`;
  if (variant === "home") {
    return <article className="home-course-card" data-course-id={course.id}>
      <Link prefetch={false} className="home-course-link" href={`/${locale}/portal/courses/${course.id}`} aria-label={`${copy.viewCourse}: ${course.title}`}>
        <div className="home-course-cover"><CourseThumbnail slug={course.slug} title={course.title} src={course.cover || course.thumbnailPath} />{category ? <span className="home-course-category">{category}</span> : null}</div>
        <div className="home-course-body"><div className="home-course-heading"><h3>{course.title}</h3><p className="home-course-meta">{lessons.length} {copy.lessonCount}{duration ? ` · ${duration}` : null}</p></div>
          <div className="home-course-description"><p title={course.description}>{course.description}</p></div>
        </div>
      </Link>
    </article>;
  }
  return <article className="portal-course-card">
    <Link prefetch={false} className="portal-course-link" href={`/${locale}/portal/courses/${course.id}`} aria-label={`${copy.viewCourse}: ${course.title}`}>
      <div className="portal-course-image-wrap"><CourseThumbnail slug={course.slug} title={course.title} src={course.cover || course.thumbnailPath} />{category ? <span className="portal-course-category">{category}</span> : null}</div>
      <div className="portal-course-card-body">
        <div className="portal-course-heading"><h3>{course.title}</h3><div className="portal-course-meta">{lessons.length} {copy.lessonCount}{duration ? ` · ${duration}` : null}</div></div>
        <div className="portal-course-card-bottom"><p title={course.description}>{course.description}</p></div>
      </div>
    </Link>
  </article>;
}
