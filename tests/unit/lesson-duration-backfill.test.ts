import assert from "node:assert/strict";
import { test } from "node:test";

import * as migration from "../../db/data-migrations/021_align_lesson_minutes_with_media";
import { createMemoryOrm } from "../../services/dataMigrations";
import type { ProductCourse } from "../../services/productStore";

// BUG-0348：媒体时长是唯一真源。任何"有实测媒体、但分钟数是手填/旧的"课时都要被对齐。
const now = "2026-11-15T00:00:00.000Z";

function course(overrides: Partial<ProductCourse> & { sections: ProductCourse["sections"] }): ProductCourse {
  return {
    id: "c1",
    slug: "c1",
    title: "C1",
    description: "",
    status: "published",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ProductCourse;
}

function ormWith(courses: ProductCourse[]) {
  return createMemoryOrm({ tables: { courses } });
}

test("a hand-entered duration is replaced by the media-derived minutes", () => {
  const orm = ormWith([
    course({
      sections: [
        {
          id: "s1",
          title: "S1",
          lessons: [
            { id: "l1", title: "L1", body: "", durationMinutes: 40, videoDurationSeconds: 1469, isPublic: true },
          ],
        },
      ],
    }),
  ]);
  const changes = migration.apply(orm, { now, store: "memory", dryRun: false });
  assert.deepEqual(changes, [{ action: "update", kind: "lesson", id: "l1", reason: "duration:40->25" }]);
  assert.equal(orm.table<ProductCourse>("courses").findById("c1")?.sections[0].lessons[0].durationMinutes, 25);
});

test("lessons already matching the media, or without media, are left alone", () => {
  const orm = ormWith([
    course({
      sections: [
        {
          id: "s1",
          title: "S1",
          lessons: [
            { id: "l1", title: "L1", body: "", durationMinutes: 25, videoDurationSeconds: 1469, isPublic: true },
            { id: "l2", title: "L2", body: "", durationMinutes: 18, isPublic: true },
            { id: "l3", title: "L3", body: "", durationMinutes: 30, videoDurationSeconds: 0, isPublic: true },
          ],
        },
      ],
    }),
  ]);
  const changes = migration.apply(orm, { now, store: "memory", dryRun: false });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].action, "skip");
  assert.deepEqual(
    orm.table<ProductCourse>("courses").findById("c1")?.sections[0].lessons.map((lesson) => lesson.durationMinutes),
    [25, 18, 30],
  );
});

test("running it twice changes nothing the second time", () => {
  const orm = ormWith([
    course({
      sections: [
        {
          id: "s1",
          title: "S1",
          lessons: [
            { id: "l1", title: "L1", body: "", durationMinutes: 40, videoDurationSeconds: 1584, isPublic: true },
          ],
        },
      ],
    }),
  ]);
  assert.equal(migration.apply(orm, { now, store: "memory", dryRun: false })[0].reason, "duration:40->27");
  assert.equal(migration.apply(orm, { now, store: "memory", dryRun: false })[0].action, "skip");
});

test("the course's updatedAt moves forward exactly once", () => {
  const orm = ormWith([
    course({
      sections: [
        {
          id: "s1",
          title: "S1",
          lessons: [
            { id: "l1", title: "L1", body: "", durationMinutes: 1, videoDurationSeconds: 120, isPublic: true },
          ],
        },
      ],
    }),
  ]);
  migration.apply(orm, { now, store: "memory", dryRun: false });
  assert.equal(orm.table<ProductCourse>("courses").findById("c1")?.updatedAt, "2026-11-15T00:00:00.001Z");
});
