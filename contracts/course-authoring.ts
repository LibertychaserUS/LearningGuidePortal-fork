import type { LessonContent } from "./lesson-content";

/**
 * P7 — the Portal backoffice catalogue write endpoints are closed; categories are created and
 * maintained in Admin only. The read-only transition keeps GET available.
 */
export class CatalogueManagedInAdminError extends Error {
  readonly code = "CATALOGUE_MANAGED_IN_ADMIN";
  readonly status = 410;
  constructor() {
    super("Catalogue categories are managed in the Admin course management.");
    this.name = "CatalogueManagedInAdminError";
  }
}

export type CourseMetadata = {
  subtitle?: string;
  cover?: string | null;
  level?: "" | "beginner" | "intermediate" | "advanced";
  tags?: string[];
  categoryId?: string | null;
  subjectId?: string | null;
  referencePrice?: number | null;
  discount?: number | null;
  outcomes?: string[];
  features?: string[];
};

export type AuthoringLesson = {
  id: string;
  title: string;
  body: string;
  /** Public plain-text syllabus introduction; never derived from protected content. */
  summary?: string;
  durationMinutes: number;
  videoDurationSeconds?: number | null;
  isPublic: boolean;
  contents?: LessonContent[];
};
export type CourseDraftInput = CourseMetadata & {
  expectedUpdatedAt: string;
  title: string;
  description: string;
  sections: Array<{ id: string; title: string; lessons: AuthoringLesson[] }>;
  removedSectionIds?: string[];
  removedLessonIds?: string[];
};

export type CatalogueEntry = {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type CatalogueInput = { name: string; description?: string; parentId?: string | null; expectedUpdatedAt?: string; status?: "active" | "archived" };
export type CourseListQuery = { search?: string; status?: "draft" | "published" | "archived" | "all"; categoryId?: string; subjectId?: string; level?: string; page?: number; pageSize?: number };
