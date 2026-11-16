import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCoursePageCta, type CoursePageState } from "../../lib/coursePage";

// 锁住课程详情页 CTA 的现有判定（BUG-0348 同批的"安全简化"前置测试）。
const base = {
  pageState: "available" as CoursePageState,
  hasLiveEntitlement: false,
  accessEnded: false,
  previewLessonIds: ["l1"],
  openedLessonIds: [] as string[],
  completedPreviewIds: [] as string[],
};

const cases: Array<[string, Partial<typeof base>, string | null]> = [
  ["withdrawn course has no CTA", { pageState: "withdrawn" }, null],
  ["failed course has no CTA", { pageState: "failed" }, null],
  ["subscribed learner continues learning", { hasLiveEntitlement: true }, "continue_learning"],
  ["entitlement wins over ended access", { hasLiveEntitlement: true, accessEnded: true }, "continue_learning"],
  ["ended access goes to plans", { accessEnded: true }, "view_plans"],
  ["untouched preview starts", {}, "start_preview"],
  ["opened preview continues", { openedLessonIds: ["l1"] }, "continue_preview"],
  ["finished preview goes to plans", { completedPreviewIds: ["l1"] }, "view_plans"],
  ["finished and opened preview goes to plans", { completedPreviewIds: ["l1"], openedLessonIds: ["l1"] }, "view_plans"],
  ["no preview lesson goes to plans", { previewLessonIds: [] }, "view_plans"],
  ["opened id outside the preview list is ignored", { openedLessonIds: ["other"] }, "start_preview"],
];

for (const [name, overrides, expected] of cases) {
  test(name, () => {
    assert.equal(resolveCoursePageCta({ ...base, ...overrides }), expected);
  });
}
