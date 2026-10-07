import { expect, test } from "@playwright/test";

const concertName = "Open concert: Pagination investigation";

test("Delete concert: cancel keeps the concert and its detail selection", async ({
  page,
}) => {
  const detail = page.getByTestId("concert-detail");
  await page.goto("/?concerts");
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await page.getByRole("button", { name: concertName, exact: true }).click();
  await expect(detail).toContainText("0 of 3 tasks reported complete");
  // The unfinished concert cannot be deleted yet; the muted helper explains why.
  const trigger = detail.getByTestId("concert-delete");
  await expect(trigger).toBeDisabled();
  await expect(detail).toContainText("Only finished concerts can be deleted.");
  await page
    .getByRole("button", { name: "Source completes concert", exact: true })
    .click();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(detail.getByTestId("concert-delete-confirm")).toBeVisible();
  await expect(detail).toContainText("Delete this concert?");
  await detail.getByTestId("concert-delete-cancel").click();
  await expect(detail.getByTestId("concert-delete-confirm")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: concertName, exact: true }),
  ).toBeVisible();
  await expect(detail.getByTestId("concert-delete")).toBeEnabled();
});

test("Delete concert: confirming removes it from the list and clears the detail", async ({
  page,
}) => {
  const detail = page.getByTestId("concert-detail");
  await page.goto("/?concerts&delete-slow");
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await page.getByRole("button", { name: concertName, exact: true }).click();
  await page
    .getByRole("button", { name: "Source completes concert", exact: true })
    .click();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
  await detail.getByTestId("concert-delete").click();
  await detail.getByTestId("concert-delete-confirm").click();
  // While the request is in flight, the confirm control shows Deleting….
  await expect(detail.getByTestId("concert-delete-confirm")).toBeDisabled();
  await expect(detail.getByTestId("concert-delete-confirm")).toHaveText(
    "Deleting…",
  );
  await expect(
    page.getByRole("button", { name: concertName, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("No concerts yet", { exact: true }),
  ).toBeVisible();
  // The selection is cleared, so the browser shows its empty state again.
  await expect(detail).toHaveCount(0);
  await expect(
    page.getByText("Choose a concert to follow.", { exact: true }),
  ).toBeVisible();
});

test("Delete concert: the action stays disabled while a task is running", async ({
  page,
}) => {
  const detail = page.getByTestId("concert-detail");
  await page.goto("/?concerts");
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await page.getByRole("button", { name: concertName, exact: true }).click();
  await page
    .getByRole("button", { name: "Source claims task", exact: true })
    .click();
  await expect(page.getByTestId("concert-task-api")).toContainText("Running");
  const trigger = detail.getByTestId("concert-delete");
  await expect(trigger).toBeDisabled();
  await expect(detail).toContainText("Only finished concerts can be deleted.");
  // The confirmation never opens for a disabled action.
  await expect(detail.getByTestId("concert-delete-confirm")).toHaveCount(0);
});

test("Delete concert: a server refusal surfaces as an alert and keeps the concert", async ({
  page,
}) => {
  const detail = page.getByTestId("concert-detail");
  await page.goto("/?concerts&delete-error");
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await page.getByRole("button", { name: concertName, exact: true }).click();
  await page
    .getByRole("button", { name: "Source completes concert", exact: true })
    .click();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
  await detail.getByTestId("concert-delete").click();
  await detail.getByTestId("concert-delete-confirm").click();
  await expect(detail.getByRole("alert")).toContainText(
    "This concert changed. Refresh before deleting.",
  );
  await expect(
    page.getByRole("button", { name: concertName, exact: true }),
  ).toBeVisible();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
});

test("Delete concert: the compact confirmation wraps inside the viewport", async ({
  page,
}) => {
  const width = 390;
  await page.setViewportSize({ width, height: 844 });
  const detail = page.getByTestId("concert-detail");
  await page.goto("/?concerts");
  await page.getByRole("tab", { name: "Concerts", exact: true }).click();
  await page.getByRole("button", { name: concertName, exact: true }).click();
  await page
    .getByRole("button", { name: "Source completes concert", exact: true })
    .click();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
  await detail.getByTestId("concert-delete").click();
  const action = detail.getByTestId("concert-delete-action");
  await expect(action).toContainText("Delete this concert?");
  for (const target of [
    action,
    detail.getByTestId("concert-delete-confirm"),
    detail.getByTestId("concert-delete-cancel"),
  ]) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
  }
  // Both confirmation buttons keep a 44px touch target at compact width.
  for (const id of ["concert-delete-confirm", "concert-delete-cancel"]) {
    const box = await detail.getByTestId(id).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
  // Keyboard: Cancel stays reachable and dismisses the confirmation.
  await detail.getByTestId("concert-delete-cancel").focus();
  await page.keyboard.press("Enter");
  await expect(detail.getByTestId("concert-delete-confirm")).toHaveCount(0);
});
