import { expect, test } from "@playwright/test";

test("Needs attention combines requests, failures, and reminders and updates its count when snoozed", async ({
  page,
}) => {
  await page.goto("/?reminder");
  const filter = page.getByRole("button", {
    name: "Needs attention",
    exact: true,
  });
  await expect(filter).toContainText("6");
  await expect(
    page.getByRole("button", { name: "Waiting", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Open Choose a pagination strategy/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Open Run the focused test suite/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Integration checks", exact: true }),
  ).toBeVisible();
  const reminder = page.getByRole("button", {
    name: "Open Existing workspace agent",
    exact: true,
  });
  await expect(reminder).toContainText("Manual reminder");
  await reminder.click();
  await page
    .getByRole("button", { name: "Clear my reminder", exact: true })
    .click();
  await expect(reminder).toHaveCount(0);
  await expect(filter).toContainText("5");
  await page
    .getByRole("button", { name: "Open Integration checks", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Snooze 15 min", exact: true })
    .click();
  await expect(filter).toContainText("4");
  await page.getByRole("button", { name: "Show snoozed", exact: true }).click();
  await expect(filter).toContainText("5");
  await expect(
    page.getByRole("button", { name: "Open Integration checks", exact: true }),
  ).toContainText("Snoozed");
  await page.getByRole("button", { name: "Next item →", exact: true }).click();
  await expect(page.getByTestId("request-detail")).toContainText(
    "Choose a pagination strategy",
  );
});

test("answer, preserve another draft, and move through requests and failures", async ({
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
  await page.getByRole("button", { name: "Next item →" }).click();
  await expect(page.getByTestId("request-detail")).toContainText(
    "Integration checks",
  );
  await expect(page.getByTestId("request-detail")).toContainText(
    "The provider stopped before returning a result.",
  );
  await page.getByRole("button", { name: "Next item →" }).click();
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
  await page
    .getByRole("button", { name: "Needs attention", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search agents and requests" })
    .fill("migration");
  await page
    .getByRole("button", { name: /Open Review the proposed migration plan/ })
    .click();
  await expect(page.getByTestId("preview-status")).toContainText(
    "agent-native",
  );
  await expect(
    page.getByRole("button", { name: "Send answer", exact: true }),
  ).toHaveCount(0);
});
test("Claude plans and unsupported questions open the agent from the queue and Next item without sending a response", async ({
  page,
}) => {
  for (const suffix of ["", "&malformed-question"]) {
    await page.goto(`/?native-only${suffix}`);
    await page
      .getByRole("button", { name: /Open Review the proposed migration plan/ })
      .click();
    await expect(page.getByTestId("preview-status")).toContainText(
      "agent-native · sends:0",
    );
    await expect(page.getByTestId("request-detail")).toHaveCount(0);
    await page.goto(`/?native-only${suffix}`);
    await page
      .getByRole("button", { name: "Next item →", exact: true })
      .click();
    await expect(page.getByTestId("preview-status")).toContainText(
      "agent-native · sends:0",
    );
    await expect(page.getByTestId("request-detail")).toHaveCount(0);
  }
});
test("native-only requests explain missing navigation without displaying their raw JSON", async ({
  page,
}) => {
  await page.goto("/?native-only&no-navigation");
  await page
    .getByRole("button", { name: /Open Review the proposed migration plan/ })
    .click();
  await expect(page.getByTestId("request-detail")).toContainText(
    "Open this request in the agent to use its native controls.",
  );
  await expect(
    page.getByRole("button", { name: "Open agent ↗", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Show request details", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Proposed migration plan/)).toHaveCount(0);
  await expect(page.getByTestId("preview-status")).toContainText("sends:0");
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
    page.getByRole("button", { name: "Next item →" }),
  ).toBeDisabled();
});

test("existing agents stay discoverable when no agent needs attention; toolbar controls align", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?no-attention");
  await expect(page.getByTestId("agent-coverage")).toContainText("4 agents");
  await expect(page.getByText("No agents need attention")).toBeVisible();
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
  await page
    .getByRole("button", { name: "Needs attention", exact: true })
    .click();
  await page.screenshot({
    path: "test-results/conductor-empty-attention.png",
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
    page.getByTestId("agents-queue").getByText(/Last turn|Turn outcome/),
  ).toHaveCount(0);
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

test("four filters keep child context when parents are hidden and nest visible families", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?family");
  for (const label of ["Needs attention", "Running", "Inactive", "All"]) {
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }
  for (const label of [
    "Waiting",
    "Idle",
    "Closed",
    "Turn ended",
    "Failed",
    "Snoozed",
  ]) {
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toHaveCount(0);
  }
  const child = page.getByRole("button", {
    name: /Open Run the focused test suite from Worker B/,
  });
  await expect(child).toContainText("Parent: Coordinator A");
  await expect(
    page.getByRole("button", { name: "Open Coordinator A", exact: true }),
  ).toHaveCount(0);
  await child.click();
  await expect(page.getByTestId("parent-agent")).toContainText("PARENT AGENT");
  await expect(page.getByTestId("parent-agent")).toContainText("Coordinator A");
  await page
    .getByTestId("parent-agent")
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
    expect(childBounds.x - parentBounds.x).toBeGreaterThanOrEqual(32);
    expect(parentBounds.height).toBeLessThanOrEqual(100);
    expect(childBounds.height).toBeLessThanOrEqual(100);
  }
  await expect(child).not.toContainText("Parent:");
  await page.screenshot({
    path: "test-results/conductor-family.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?family&dark");
  await page.getByRole("button", { name: "All", exact: true }).click();
  const compactParent = await page
    .getByRole("button", { name: "Open Coordinator A", exact: true })
    .boundingBox();
  const compactChild = await child.boundingBox();
  expect(compactParent).not.toBeNull();
  expect(compactChild).not.toBeNull();
  if (compactParent && compactChild) {
    expect(compactChild.x - compactParent.x).toBeGreaterThanOrEqual(32);
    expect(compactChild.height).toBeLessThanOrEqual(100);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/conductor-family-mobile-dark.png",
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
