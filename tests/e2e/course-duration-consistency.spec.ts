import { expect, test } from "playwright/test";

// BUG-0348: 同一门课在课程目录卡片与课程详情页显示的时长不一致
// （Modeling life：卡片 0h 51m，详情 0h 52m）。两者必须来自同一个计算源。
function minutesFrom(label: string): number {
  const match = /(\d+)\s*h\s*(\d+)\s*m/.exec(label);
  if (!match) throw new Error(`no duration in "${label}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}

test("catalogue card and course page show the same total duration", async ({ page }) => {
  await page.goto("/en-GB/portal/courses");

  const card = page.locator(".portal-course-card", { hasText: "Modeling life" });
  await expect(card).toBeVisible();
  const cardText = (await card.innerText()).replace(/\s+/g, " ");
  const cardMinutes = minutesFrom(cardText);

  await page.goto("/en-GB/portal/courses/modeling-life");

  // The detail page exposes the number it decided on, and prints it for the reader.
  const identity = page.locator("[data-total-minutes]");
  await expect(identity).toBeVisible();
  const detailMinutes = Number(await identity.getAttribute("data-total-minutes"));

  expect(detailMinutes, `card says ${cardMinutes}/${detailMinutes} on the page`).toBe(cardMinutes);
  expect(minutesFrom(await identity.innerText())).toBe(cardMinutes);
});
