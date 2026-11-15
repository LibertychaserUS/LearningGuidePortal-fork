import assert from "node:assert/strict";
import { test } from "node:test";

import { totalVideoMinutes } from "../../lib/courseDuration";
import { courseIdentityFrom } from "../../lib/coursePage";

// BUG-0348：课程目录卡片与课程详情页对"课程总时长"各算一套，同一门课显示 51 / 52。
// 真源是课程内容：有实测媒体时长时用实测（向上取整到分钟），否则退回编排分钟。
const modelingLife = {
  title: "Modeling life",
  status: "published",
  sections: [
    {
      lessons: [
        { id: "l1", title: "Lesson 1", isPublic: true, durationMinutes: 25, videoDurationSeconds: 1469 },
        { id: "l2", title: "Lesson 2", isPublic: false, durationMinutes: 27, videoDurationSeconds: 1584 },
      ],
    },
  ],
};

test("the lesson list and the card agree on 51 minutes", () => {
  assert.equal(totalVideoMinutes(modelingLife.sections[0].lessons), 51);
});

test("course identity takes its total from the same source as the card", () => {
  assert.equal(courseIdentityFrom(modelingLife).totalMinutes, 51);
});

test("without measured media both fall back to the authored minutes", () => {
  const authored = {
    ...modelingLife,
    sections: [
      {
        lessons: [
          { id: "l1", title: "Lesson 1", isPublic: true, durationMinutes: 25 },
          { id: "l2", title: "Lesson 2", isPublic: false, durationMinutes: 27 },
        ],
      },
    ],
  };
  assert.equal(courseIdentityFrom(authored).totalMinutes, 52);
  const noMedia: Array<{ videoDurationSeconds?: number | null }> = [{}, {}];
  assert.equal(totalVideoMinutes(noMedia), null);
});
