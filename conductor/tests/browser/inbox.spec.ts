import { expect, test } from "@playwright/test";

test("answer, preserve another draft, and move to the next waiting request", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await page
    .getByRole("textbox", { name: "Answer: Pagination" })
    .fill("Keep this request-specific draft");
  await page
    .getByRole("button", { name: /Open Run the focused test suite/ })
    .click();
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Answer: Pagination" }),
  ).toHaveValue("Keep this request-specific draft");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(
    page.getByText("This item changed or was resolved."),
  ).toBeVisible();
  await expect(page.getByTestId("preview-status")).toContainText("sends:1");
  await page.getByRole("button", { name: "Next waiting →" }).click();
  await expect(page.getByTestId("request-detail")).toContainText(
    "Run the focused test suite",
  );
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm Allow once", exact: true })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText("sends:2");
});
test("unknown delivery locks the response; native navigation remains available", async ({
  page,
}) => {
  await page.goto("/?uncertain");
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await page.getByRole("radio", { name: "Cursor pagination" }).click();
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(page.getByText(/Delivery is uncertain/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send answer", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Open agent ↗", exact: true })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText("agent-api");
});
test("snooze, search, native forms and stale state are explicit", async ({
  page,
}) => {
  await page.goto("/?stale");
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Send answer", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: "Snooze 15 min", exact: true })
    .click();
  await page.getByRole("button", { name: "Show snoozed", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Open Choose a pagination strategy/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await page.getByRole("button", { name: "Unsnooze", exact: true }).click();
  await page.getByRole("button", { name: "Waiting", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search agents and requests" })
    .fill("migration");
  await page
    .getByRole("button", { name: /Open Review the proposed migration plan/ })
    .click();
  await expect(
    page.getByText(
      "Open this request in the agent to use its native controls.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send answer", exact: true }),
  ).toHaveCount(0);
});
test("compact dark layout preserves drafts and has no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?dark");
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await page
    .getByRole("textbox", { name: "Answer: Pagination" })
    .fill("Mobile draft");
  await page
    .getByRole("button", { name: "← Back to queue", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Answer: Pagination" }),
  ).toHaveValue("Mobile draft");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/conductor-mobile-dark.png",
    fullPage: true,
  });
});
test("desktop and empty states render, keyboard focus reaches a control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?incomplete");
  await expect(page.getByText(/Directory is incomplete/)).toBeVisible();
  await page
    .getByRole("button", { name: /Open Choose a pagination strategy/ })
    .click();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveCount(1);
  await page.screenshot({
    path: "test-results/conductor-desktop-light.png",
    fullPage: true,
  });
  await page.goto("/?empty");
  await expect(page.getByText("No agents in this scope")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next waiting →" }),
  ).toBeDisabled();
});

test("existing agents stay discoverable when no one is waiting; toolbar controls align", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?no-waiting");
  await expect(page.getByTestId("agent-coverage")).toContainText("4 agents");
  await expect(page.getByText("No agents waiting for you")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inactive", exact: true }),
  ).toContainText("3");
  await page
    .getByRole("button", { name: "View all agents", exact: true })
    .click();
  await expect(
    page.getByText("Existing workspace agent", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inactive", exact: true }).click();
  const idleCard = page.getByRole("button", {
    name: "Open Existing workspace agent",
    exact: true,
  });
  await expect(idleCard.getByText("Idle", { exact: true })).toHaveCount(1);
  await expect(
    idleCard.getByText("Existing workspace agent", { exact: true }),
  ).toHaveCount(1);
  await idleCard.click();
  await expect(
    page.getByRole("heading", {
      name: "Existing workspace agent",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Needs my reply", exact: true }),
  ).toHaveCount(0);
  const input = await page
    .getByRole("textbox", { name: "Search agents and requests" })
    .boundingBox();
  const group = await page
    .getByRole("button", { name: "Group: project", exact: true })
    .boundingBox();
  expect(input).not.toBeNull();
  expect(group).not.toBeNull();
  if (input && group) {
    expect(Math.abs(input.y - group.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(input.height - group.height)).toBeLessThanOrEqual(1);
  }
  await page.getByRole("button", { name: "Waiting", exact: true }).click();
  await page.screenshot({
    path: "test-results/conductor-empty-waiting.png",
    fullPage: true,
  });
});

test("closed sessions and recorded turn endings are distinct from verified completion", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Finished", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Inactive", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Closed session", exact: true })
    .click();
  await expect(page.getByTestId("request-detail")).toContainText(
    "Outcome unknown",
  );
  await expect(
    page.getByRole("button", { name: "Needs my reply", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("button", { name: "Open Closed session", exact: true })
      .getByText("Closed", { exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Inactive", exact: true }).click();
  await page
    .getByRole("button", { name: "Open API review", exact: true })
    .click();
  await expect(page.getByTestId("request-detail")).toContainText(
    "Last turn completed",
  );
  await expect(page.getByTestId("request-detail")).toContainText(
    "Task completion: not verified by Conductor.",
  );
  await page.screenshot({
    path: "test-results/conductor-turn-outcome.png",
    fullPage: true,
  });
});

test("five filters keep child context when parents are hidden and nest visible families", async ({
  page,
}) => {
  await page.goto("/?family");
  for (const label of [
    "Waiting",
    "Needs attention",
    "Running",
    "Inactive",
    "All",
  ]) {
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }
  for (const label of ["Idle", "Closed", "Turn ended", "Failed", "Snoozed"]) {
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toHaveCount(0);
  }
  const child = page.getByRole("button", {
    name: /Open Run the focused test suite from Worker B/,
  });
  await expect(child).toContainText("Child of Coordinator A");
  await expect(
    page.getByRole("button", { name: "Open Coordinator A", exact: true }),
  ).toHaveCount(0);
  await child.click();
  await page
    .getByRole("button", { name: "Open parent ↗", exact: true })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText("agent-api");
  await page.getByRole("button", { name: "All", exact: true }).click();
  const parentBounds = await page
    .getByRole("button", { name: "Open Coordinator A", exact: true })
    .boundingBox();
  const childBounds = await child.boundingBox();
  expect(parentBounds).not.toBeNull();
  expect(childBounds).not.toBeNull();
  if (parentBounds && childBounds) {
    expect(childBounds.y).toBeGreaterThan(parentBounds.y);
    expect(childBounds.x).toBeGreaterThan(parentBounds.x);
  }
  await page.screenshot({
    path: "test-results/conductor-family.png",
    fullPage: true,
  });
});

test("archive requires confirmation, removes an inactive leaf, and protects parents", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Inactive", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Closed session", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Archive agent", exact: true })
    .click();
  await expect(page.getByText(/Archive Closed session\?/)).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel archive", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open Closed session", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Archive agent", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm archive", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open Closed session", exact: true }),
  ).toHaveCount(0);
  await page.goto("/?family&inactive-parent");
  await page.getByRole("button", { name: "Inactive", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Coordinator A", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Archive agent", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/Archive children first/)).toBeVisible();
});

test("a changed agent cannot be archived from an old view", async ({
  page,
}) => {
  await page.goto("/?archive-stale");
  await page.getByRole("button", { name: "Inactive", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Closed session", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Archive agent", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm archive", exact: true })
    .click();
  await expect(page.getByText(/The agent changed/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Closed session", exact: true }),
  ).toBeVisible();
});
