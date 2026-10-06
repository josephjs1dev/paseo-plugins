import { expect, test } from "@playwright/test";

const runName = "Open run: Pagination investigation";

test("Delete run: cancel keeps the run and its detail selection", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  await page.goto("/?runs");
  await page.getByRole("tab", { name: "Runs", exact: true }).click();
  await page.getByRole("button", { name: runName, exact: true }).click();
  await expect(detail).toContainText("0 of 3 tasks reported complete");
  // The unfinished run cannot be deleted yet; the muted helper explains why.
  const trigger = detail.getByTestId("run-delete");
  await expect(trigger).toBeDisabled();
  await expect(detail).toContainText("Only finished runs can be deleted.");
  await page
    .getByRole("button", { name: "Source completes run", exact: true })
    .click();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(detail.getByTestId("run-delete-confirm")).toBeVisible();
  await expect(detail).toContainText("Delete this run?");
  await detail.getByTestId("run-delete-cancel").click();
  await expect(detail.getByTestId("run-delete-confirm")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: runName, exact: true }),
  ).toBeVisible();
  await expect(detail.getByTestId("run-delete")).toBeEnabled();
});

test("Delete run: confirming removes it from the list and clears the detail", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  await page.goto("/?runs&delete-slow");
  await page.getByRole("tab", { name: "Runs", exact: true }).click();
  await page.getByRole("button", { name: runName, exact: true }).click();
  await page
    .getByRole("button", { name: "Source completes run", exact: true })
    .click();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
  await detail.getByTestId("run-delete").click();
  await detail.getByTestId("run-delete-confirm").click();
  // While the request is in flight, the confirm control shows Deleting….
  await expect(detail.getByTestId("run-delete-confirm")).toBeDisabled();
  await expect(detail.getByTestId("run-delete-confirm")).toHaveText(
    "Deleting…",
  );
  await expect(
    page.getByRole("button", { name: runName, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("No runs yet", { exact: true })).toBeVisible();
  // The selection is cleared, so the browser shows its empty state again.
  await expect(detail).toHaveCount(0);
  await expect(
    page.getByText("Choose a run to follow.", { exact: true }),
  ).toBeVisible();
});

test("Delete run: the action stays disabled while a task is running", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  await page.goto("/?runs");
  await page.getByRole("tab", { name: "Runs", exact: true }).click();
  await page.getByRole("button", { name: runName, exact: true }).click();
  await page
    .getByRole("button", { name: "Source claims task", exact: true })
    .click();
  await expect(page.getByTestId("run-task-api")).toContainText("Running");
  const trigger = detail.getByTestId("run-delete");
  await expect(trigger).toBeDisabled();
  await expect(detail).toContainText("Only finished runs can be deleted.");
  // The confirmation never opens for a disabled action.
  await expect(detail.getByTestId("run-delete-confirm")).toHaveCount(0);
});

test("Delete run: a server refusal surfaces as an alert and keeps the run", async ({
  page,
}) => {
  const detail = page.getByTestId("run-detail");
  await page.goto("/?runs&delete-error");
  await page.getByRole("tab", { name: "Runs", exact: true }).click();
  await page.getByRole("button", { name: runName, exact: true }).click();
  await page
    .getByRole("button", { name: "Source completes run", exact: true })
    .click();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
  await detail.getByTestId("run-delete").click();
  await detail.getByTestId("run-delete-confirm").click();
  await expect(detail.getByRole("alert")).toContainText(
    "This run changed. Refresh before deleting.",
  );
  await expect(
    page.getByRole("button", { name: runName, exact: true }),
  ).toBeVisible();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
});

test("Delete run: the compact confirmation wraps inside the viewport", async ({
  page,
}) => {
  const width = 390;
  await page.setViewportSize({ width, height: 844 });
  const detail = page.getByTestId("run-detail");
  await page.goto("/?runs");
  await page.getByRole("tab", { name: "Runs", exact: true }).click();
  await page.getByRole("button", { name: runName, exact: true }).click();
  await page
    .getByRole("button", { name: "Source completes run", exact: true })
    .click();
  await expect(detail).toContainText("3 of 3 tasks reported complete");
  await detail.getByTestId("run-delete").click();
  const action = detail.getByTestId("run-delete-action");
  await expect(action).toContainText("Delete this run?");
  for (const target of [
    action,
    detail.getByTestId("run-delete-confirm"),
    detail.getByTestId("run-delete-cancel"),
  ]) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
  }
  // Both confirmation buttons keep a 44px touch target at compact width.
  for (const id of ["run-delete-confirm", "run-delete-cancel"]) {
    const box = await detail.getByTestId(id).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
  // Keyboard: Cancel stays reachable and dismisses the confirmation.
  await detail.getByTestId("run-delete-cancel").focus();
  await page.keyboard.press("Enter");
  await expect(detail.getByTestId("run-delete-confirm")).toHaveCount(0);
});
