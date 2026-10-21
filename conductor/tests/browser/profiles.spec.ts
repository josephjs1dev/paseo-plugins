import { expect, test, type Page } from "@playwright/test";

/**
 * The redesigned Podium Profiles tab: list column (population controls,
 * cards, inline classification warnings) beside a Paseo-style form editor.
 * Preview fixtures come from tests/preview/profiles-controller.ts; the dark
 * and narrow claims render the same fixtures through the same bundle.
 */

/** The preview controller handle exposed only under `?profiles-real`. */
interface PreviewHandle {
  otherClientSaves(name: string, changes: { instructions?: string }): void;
}

const STALE_MESSAGE =
  "Profiles changed since you opened them. Your edits are kept; review the latest profiles, then save again";

async function openProfiles(page: Page, url = "/?profiles") {
  await page.goto(url);
  await page.getByRole("tab", { name: "Profiles", exact: true }).click();
}

async function openEditor(page: Page, name: string) {
  await page.getByRole("button", { name: `Edit profile: ${name}` }).click();
  return page.getByTestId("profile-editor");
}

async function computedBorder(page: Page, testId: string): Promise<string> {
  return page
    .getByTestId(testId)
    .evaluate((element) => getComputedStyle(element).borderColor);
}

async function computedBackground(page: Page, testId: string): Promise<string> {
  return page
    .getByTestId(testId)
    .evaluate((element) => getComputedStyle(element).backgroundColor);
}

/** WCAG components: blended surface, then the AA ratio against text. */
function channels(value: string): number[] {
  const match = value.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!match) {
    throw new Error(`Unreadable color: ${value}`);
  }
  return [
    Number.parseFloat(match[1] ?? "0"),
    Number.parseFloat(match[2] ?? "0"),
    Number.parseFloat(match[3] ?? "0"),
  ];
}

function luminance(color: number[]): number {
  const linear = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear(color[0] ?? 0) +
    0.7152 * linear(color[1] ?? 0) +
    0.0722 * linear(color[2] ?? 0)
  );
}

function blend(base: string, wash: string, opacity: number): number[] {
  const baseColor = channels(base);
  const washColor = channels(wash);
  return [0, 1, 2].map(
    (index) =>
      (washColor[index] ?? 0) * opacity +
      (baseColor[index] ?? 0) * (1 - opacity),
  );
}

function contrast(background: number[], foreground: number[]): number {
  const lighter = Math.max(luminance(background), luminance(foreground));
  const darker = Math.min(luminance(background), luminance(foreground));
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The warning surface measured as it paints: the tint root's own opaque
 * surface1 base blended with its statusWarning wash and computed opacity.
 * The base's composited alpha is asserted opaque, so no layer beneath it —
 * the selection tint included — can alter the result.
 */
async function warningRatio(page: Page, profileName: string): Promise<number> {
  const row = page.getByTestId(`profile-row-${profileName}`);
  const textColor = await row
    .getByTestId("profile-row-unclassified")
    .getByText(/Needs/)
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  const { wash, washOpacity, base, baseAlpha } = await row
    .getByTestId("profile-warning-tint")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const parentStyle = getComputedStyle(
        element.parentElement as HTMLElement,
      );
      return {
        wash: style.backgroundColor,
        washOpacity: Number.parseFloat(style.opacity),
        base: parentStyle.backgroundColor,
        baseAlpha:
          Number.parseFloat(parentStyle.backgroundColor.split(",")[3] ?? "1") *
          Number.parseFloat(parentStyle.opacity),
      };
    });
  expect(baseAlpha).toBeCloseTo(1, 5);
  return contrast(blend(base, wash, washOpacity), channels(textColor));
}

/** The selection tint layer's computed opacity for one card. */
async function selectionTintOpacity(
  page: Page,
  profileName: string,
): Promise<string> {
  return page
    .getByTestId(`profile-row-${profileName}`)
    .getByTestId("profile-row-tint")
    .evaluate((element) => getComputedStyle(element).opacity);
}

test("The list keeps population controls in the header with Enforce routing as a switch", async ({
  page,
}) => {
  await openProfiles(page);
  // New profile is the primary (accent) action; import is secondary.
  expect(await computedBackground(page, "profile-new")).toBe(
    "rgb(36, 94, 152)",
  );
  expect(await computedBackground(page, "profile-import")).not.toBe(
    "rgb(36, 94, 152)",
  );
  // The setting is a plain row, not a card: no fill and no frame except
  // the hairline that separates it from the profile cards below.
  const frame = await page.getByTestId("profiles-mode").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      top: style.borderTopWidth,
      bottom: style.borderBottomWidth,
    };
  });
  expect(frame).toEqual({
    background: "rgba(0, 0, 0, 0)",
    top: "0px",
    bottom: "1px",
  });
  // The toggle describes the stricter behavior the user opts into.
  const toggle = page.getByTestId("profiles-mode-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("profiles-mode-note")).toHaveText(
    "Picks outside routing are allowed and noted on the task.",
  );
  // The comparison stays collapsed until asked for, then closes again.
  await expect(page.getByTestId("profiles-mode-checked")).toHaveCount(0);
  await page.getByTestId("profiles-mode-disclosure").click();
  const checked = page.getByTestId("profiles-mode-checked");
  await expect(checked).toContainText(
    "The smallest eligible profile is always accepted.",
  );
  await expect(page.getByTestId("profiles-mode-disclosure")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(checked).toContainText("accepted and noted on the task");
  await expect(checked).toContainText(
    "A task with no eligible profile and no explicit choice is always rejected.",
  );
  await expect(checked).toContainText(
    "Turning this on also rechecks the next retry of tasks already running.",
  );
  await page.getByTestId("profiles-mode-disclosure").click();
  await expect(page.getByTestId("profiles-mode-checked")).toHaveCount(0);
  await expect(page.getByTestId("profiles-mode-disclosure")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("Cards carry notes, worker row, role chips, size badge, and an instructions indicator", async ({
  page,
}) => {
  await openProfiles(page);
  const fast = page.getByTestId("profile-row-Fast responder");
  // The worker row names model and thinking; the provider lives in the
  // accessible label beside the harness mark.
  await expect(fast).toContainText("Claude Sonnet 4.5 · Standard");
  await expect(fast).toContainText("Implementation");
  await expect(fast).toContainText("Small");
  // The instructions indicator only renders when instructions exist.
  await expect(fast.getByTestId("profile-row-instructions")).toContainText(
    "Has instructions",
  );
  const helper = page.getByTestId("profile-row-Unrouted helper");
  await expect(helper).not.toContainText("Has instructions");
  await expect(
    page
      .getByTestId("profile-row-Legacy router")
      .getByTestId("profile-row-instructions"),
  ).toHaveCount(0);
});

test("An unclassified profile warns inside its own card, not as a separate card", async ({
  page,
}) => {
  await openProfiles(page);
  // The private warning lives in the card it describes.
  const helper = page.getByTestId("profile-row-Unrouted helper");
  await expect(helper.getByTestId("profile-row-unclassified")).toContainText(
    "Needs roles and size before routing can pick it",
  );
  // A legacy profile keeps its roles but the size was never a field.
  const legacy = page.getByTestId("profile-row-Legacy router");
  await expect(legacy.getByTestId("profile-row-unclassified")).toContainText(
    "Needs a size before routing can pick it",
  );
  await expect(legacy).toContainText("Planning");
  // Classified cards show no inline warning.
  await expect(
    page
      .getByTestId("profile-row-Fast responder")
      .getByTestId("profile-row-unclassified"),
  ).toHaveCount(0);
});

test("Selecting a card highlights it with the accent boundary", async ({
  page,
}) => {
  await openProfiles(page);
  const before = await computedBorder(page, "profile-row-Fast responder");
  const idleBefore = await computedBorder(page, "profile-row-Deep reviewer");
  await page
    .getByRole("button", { name: "Edit profile: Fast responder" })
    .click();
  await expect(page.getByTestId("profile-editor")).toBeVisible();
  const after = await computedBorder(page, "profile-row-Fast responder");
  expect(after).not.toBe(before);
  expect(await computedBorder(page, "profile-row-Deep reviewer")).toBe(
    idleBefore,
  );
});

test("The editor reads like Paseo's profile form: labels above filled fields", async ({
  page,
}) => {
  await openProfiles(page);
  await openEditor(page, "Deep reviewer");
  const editor = page.getByTestId("profile-editor");
  // The title is the profile name; the uuid is not shown prominently.
  await expect(
    page.getByTestId("profile-editor-title").getByText("Deep reviewer"),
  ).toBeVisible();
  // Sentence-case labels in order, then the routing section.
  const labels = editor.getByText(
    /^Name$|^Provider$|^Model$|^Mode$|^Thinking$|^When to use$|^Routing$|^Roles$|^Size$|^Instructions$/,
  );
  await expect(labels.first()).toHaveText("Name");
  await expect(editor.getByText("Mode", { exact: true })).toBeVisible();
  await expect(
    editor.getByText("The Conductor's own permission ceiling always applies.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    editor.getByText("Helps the Conductor choose this profile."),
  ).toBeVisible();
  await expect(
    editor.getByText(
      "Your rating of the model's cost and strength. For a role, the Conductor tries smaller sizes first.",
    ),
  ).toBeVisible();
});

test("Selects show only the value with a trailing chevron, not a repeated label", async ({
  page,
}) => {
  await openProfiles(page);
  await openEditor(page, "Deep reviewer");
  const trigger = page
    .getByTestId("profile-provider-picker")
    .getByRole("button", { name: "Provider: Anthropic" });
  await expect(trigger).toHaveText("Anthropic");
  await trigger.click();
  // Choosing another provider restores value-only presentation.
  await page.getByTestId("profile-option-openai").click();
  await expect(
    page
      .getByTestId("profile-provider-picker")
      .getByRole("button", { name: "Provider: OpenAI" }),
  ).toHaveText("OpenAI");
});

test("Roles chips toggle and the Size segmented control sets and clears", async ({
  page,
}) => {
  await openProfiles(page);
  await openEditor(page, "Fast responder");
  const chip = page.getByTestId("profile-role-exploration");
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  // Toggling a role off leaves roles while the size still classifies.
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  // Size segments read as pressed only when chosen.
  const medium = page.getByTestId("profile-segment-medium");
  await expect(page.getByTestId("profile-segment-small")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(medium).toHaveAttribute("aria-pressed", "false");
  await medium.click();
  await expect(medium).toHaveAttribute("aria-pressed", "true");
  // Pressing the active segment clears the size again.
  await medium.click();
  await expect(medium).toHaveAttribute("aria-pressed", "false");
  // Setting it back and saving persists the new size.
  await medium.click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page
      .getByTestId("profile-row-Fast responder")
      .getByTestId("profile-row-size-medium"),
  ).toBeVisible();
});

test("Save stays disabled until the draft changes, and Cancel restores the stored profile", async ({
  page,
}) => {
  await openProfiles(page);
  await openEditor(page, "Deep reviewer");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  const name = page.getByRole("textbox", { name: "Profile name" });
  await name.fill("Deep reviewer two");
  await expect(save).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(name).toHaveValue("Deep reviewer");
  await expect(save).toBeDisabled();
});

test("Creating a profile validates inline and saves after fixing", async ({
  page,
}) => {
  await openProfiles(page);
  await page.getByRole("button", { name: "New profile" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("profile-error-name")).toHaveText(
    "Enter a name.",
  );
  await expect(page.getByTestId("profile-error-provider")).toHaveText(
    "Choose or enter a provider.",
  );
  await page.getByRole("textbox", { name: "Profile name" }).fill("Docs writer");
  await page
    .getByTestId("profile-provider-picker")
    .getByRole("button", { name: "Provider" })
    .click();
  await page.getByTestId("profile-option-openai").click();
  await page
    .getByTestId("profile-model-picker")
    .getByRole("button", { name: "Model" })
    .click();
  await page.getByTestId("profile-option-gpt-5").click();
  await page.getByTestId("profile-segment-small").click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const row = page.getByTestId("profile-row-Docs writer");
  await expect(row).toBeVisible();
  await expect(row).toContainText("GPT-5");
  await expect(row.getByTestId("profile-row-size-small")).toBeVisible();
});

test("Editing stores the change, shows the saved notice, and reopens with it", async ({
  page,
}) => {
  await openProfiles(page);
  await openEditor(page, "Deep reviewer");
  const instructions = page.getByRole("textbox", { name: "Instructions" });
  await expect(instructions).toHaveValue(
    "Cite file and line numbers for every finding.",
  );
  await instructions.fill("Cite file and line numbers. Be terse.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("profile-saved-notice")).toContainText(
    "Profile saved.",
  );
  // The card keeps its instructions indicator, not the raw text.
  await expect(page.getByTestId("profile-row-Deep reviewer")).toContainText(
    "Has instructions",
  );
  // Reopening reloads the submitted draft from the store.
  await openEditor(page, "Deep reviewer");
  await expect(instructions).toHaveValue(
    "Cite file and line numbers. Be terse.",
  );
});

test("Duplicating opens a fresh unsaved draft with a copy name", async ({
  page,
}) => {
  await openProfiles(page);
  await openEditor(page, "Deep reviewer");
  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(
    page.getByText("The store assigns the id on the first save."),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Profile name" })).toHaveValue(
    "Deep reviewer (copy)",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByTestId("profile-row-Deep reviewer (copy)"),
  ).toBeVisible();
});

test("Deleting a profile asks for confirmation and removes its card", async ({
  page,
}) => {
  await openProfiles(page);
  await openEditor(page, "Unrouted helper");
  await expect(page.getByTestId("profile-delete")).toContainText("Delete");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("profile-delete-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByTestId("profile-row-Unrouted helper")).toHaveCount(0);
});

test("The Enforce routing switch is the only switch and toggles with Space", async ({
  page,
}) => {
  await openProfiles(page);
  // The display-only Switch inside the row is hidden from web accessibility,
  // leaving exactly one switch, named by its label.
  const toggle = page.getByRole("switch", { name: "Enforce routing" });
  await expect(toggle).toHaveCount(1);
  await expect(page.getByRole("switch")).toHaveCount(1);
  // Tabbing from the header buttons reaches the switch; Space toggles it
  // exactly once per press, like a native switch, and Enter already works.
  // The sync trigger is the last header button before the switch.
  await page.getByTestId("profile-sync").focus();
  await page.keyboard.press("Tab");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // A second Space returns to warn while focus stays on the switch.
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("Worker rows show a harness mark plus model for each mark kind", async ({
  page,
}) => {
  await openProfiles(page);
  // Bundled assets: the Claude mark renders as a tinted image, in its brand
  // orange on profile cards. The tint is applied through an SVG filter, so
  // the flood color of that filter is the rendered brand color.
  const claude = page.getByTestId("profile-row-Claude planner");
  await expect(claude).toContainText("Opus 5.5 · Medium");
  await expect(claude.locator("img")).toHaveCount(1);
  await expect(
    claude.getByTestId("profile-row-worker").locator("svg feFlood"),
  ).toHaveAttribute("flood-color", "#D97757");
  await expect(
    claude
      .getByTestId("profile-row-worker")
      .getByText("Opus 5.5 · Medium")
      .first(),
  ).toHaveAttribute("aria-label", "Claude, Opus 5.5, Medium");
  // Codex's brand is monochrome, so its mark keeps the theme foreground.
  const codex = page.getByTestId("profile-row-Codex runner");
  await expect(codex).toContainText("Codex Max");
  await expect(codex.locator("img")).toHaveCount(1);
  await expect(
    codex.getByTestId("profile-row-worker").locator("svg feFlood"),
  ).toHaveAttribute("flood-color", "#17212b");
  // The Pi mark is drawn from views, not an image; the brand tone paints its
  // cells with the logo's three official colors on profile cards.
  const pi = page.getByTestId("profile-row-Pi explorer");
  await expect(pi).toContainText("Pi 5 · Standard");
  const piCells = await pi
    .getByTestId("profile-row-worker")
    .evaluate((worker) => {
      // The wrapper view, then the drawn mark's root with its cell views.
      const root = worker.firstElementChild?.firstElementChild;
      return root instanceof HTMLElement
        ? Array.from(root.children).map((cell) =>
            cell instanceof HTMLElement
              ? getComputedStyle(cell).backgroundColor
              : "",
          )
        : [];
    });
  expect(await pi.locator("img").count()).toBe(0);
  expect(piCells).toHaveLength(10);
  expect(piCells[0]).toBe("rgb(240, 144, 130)");
  expect(piCells[3]).toBe("rgb(77, 154, 191)");
  expect(piCells[7]).toBe("rgb(241, 190, 88)");
  // An unknown provider keeps its raw ids and falls back to a monogram.
  const mistral = page.getByTestId("profile-row-Mistral oddball");
  await expect(mistral).toContainText("mistral-large-3");
  const monogram = await mistral
    .getByTestId("profile-row-worker")
    .evaluate((worker) => worker.firstElementChild?.textContent ?? "");
  expect(monogram).toBe("M");
  await expect(
    mistral
      .getByTestId("profile-row-worker")
      .getByText("mistral-large-3")
      .first(),
  ).toHaveAttribute("aria-label", "mistral, mistral-large-3");
});

test("Cards lift off the pane and tint their chips per theme", async ({
  page,
}) => {
  for (const url of ["/?profiles", "/?profiles&dark"] as const) {
    const dark = url.includes("dark");
    await openProfiles(page, url);
    const fast = page.getByTestId("profile-row-Fast responder");
    // The card keeps its surface1 fill over the surface0 pane; the soft
    // shadow separates it in light only, dark keeps the border alone.
    expect(await computedBackground(page, "profile-row-Fast responder")).toBe(
      dark ? "rgb(28, 34, 42)" : "rgb(255, 255, 255)",
    );
    expect(
      await fast.evaluate((element) => getComputedStyle(element).boxShadow),
    ).toBe(dark ? "none" : "rgba(0, 0, 0, 0.1) 0px 2px 6px 0px");
    // The worker line reads in the foreground, not the muted tone.
    const workerText = fast
      .getByTestId("profile-row-worker")
      .getByText("Claude Sonnet 4.5 · Standard")
      .first();
    expect(
      await workerText.evaluate((element) => getComputedStyle(element).color),
    ).toBe(dark ? "rgb(237, 241, 245)" : "rgb(23, 33, 43)");
    // The role chip carries its tint pair, which passes AA in both themes.
    const chip = fast.getByTestId("profile-row-chip-implementation");
    const chipBackground = channels(
      await chip.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    );
    const chipForeground = channels(
      await chip
        .getByText("Implementation")
        .evaluate((element) => getComputedStyle(element).color),
    );
    expect(contrast(chipBackground, chipForeground)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(chipBackground).toEqual(dark ? [29, 48, 71] : [227, 238, 251]);
    // The size badge stays neutral on the surface2 fill.
    expect(
      await fast
        .getByTestId("profile-row-size")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe(dark ? "rgb(41, 51, 66)" : "rgb(237, 241, 245)");
  }
});

test("The routing mode toggles, keeps its state, and disables while saving", async ({
  page,
}) => {
  await openProfiles(page);
  const toggle = page.getByTestId("profiles-mode-toggle");
  await toggle.click();
  // The preview mode write stays pending briefly; the switch reports busy
  // and no second toggle can start while it does.
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // RNW drops the attribute once the write finishes; the toggle re-enables.
  await expect(toggle).not.toHaveAttribute("aria-disabled");
  // The switch and its description are the feedback; no banner repeats
  // the raw mode value.
  await expect(page.getByTestId("profiles-panel-notice")).toHaveCount(0);
  await expect(page.getByTestId("profiles-mode-note")).toHaveText(
    "Picks outside routing need a justification with evidence, or they are rejected.",
  );
  // Toggling again returns to warn and its description.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("profiles-panel-notice")).toHaveCount(0);
  await expect(page.getByTestId("profiles-mode-note")).toHaveText(
    "Picks outside routing are allowed and noted on the task.",
  );
});

test("Importing from Paseo profiles reports a dismissible success notice", async ({
  page,
}) => {
  await openProfiles(page);
  await page
    .getByRole("button", { name: "Import from Paseo profiles" })
    .click();
  await expect(page.getByTestId("profiles-panel-notice")).toContainText(
    "Imported 2 profiles",
  );
  await expect(page.getByTestId("profile-row-Docs writer")).toBeVisible();
  await expect(page.getByTestId("profile-row-Migration runner")).toBeVisible();
  // Imported profiles have no routing yet, so their cards warn inline.
  await expect(
    page
      .getByTestId("profile-row-Docs writer")
      .getByTestId("profile-row-unclassified"),
  ).toContainText("Needs roles and size");
  await page.getByTestId("profiles-notice-dismiss").first().click();
  await expect(page.getByTestId("profiles-panel-notice")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Import from Paseo profiles" })
    .click();
  await expect(page.getByTestId("profiles-panel-notice")).toContainText(
    "Imported 0 profiles. Skipped: Docs writer",
  );
});

test("An empty store explains profiles and starts from the import action", async ({
  page,
}) => {
  await openProfiles(page, "/?profiles&profiles-empty");
  await expect(page.getByTestId("profiles-empty")).toContainText(
    "Set up your first profile",
  );
  await expect(page.getByTestId("profiles-empty")).toContainText("Import your");
  // The empty store flips the emphasis: import becomes the primary action.
  expect(await computedBackground(page, "profile-import")).toBe(
    "rgb(36, 94, 152)",
  );
  expect(await computedBackground(page, "profile-new")).not.toBe(
    "rgb(36, 94, 152)",
  );
  await page.getByRole("button", { name: "New profile" }).click();
  await page.getByRole("textbox", { name: "Profile name" }).fill("Solo worker");
  await page
    .getByTestId("profile-provider-picker")
    .getByRole("button", { name: "Provider" })
    .click();
  await page.getByTestId("profile-option-anthropic").click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("profile-row-Solo worker")).toBeVisible();
});

test("An invalid store warns that the next save replaces it", async ({
  page,
}) => {
  await openProfiles(page, "/?profiles&profiles-invalid");
  const banner = page.getByTestId("profiles-invalid-notice");
  await expect(banner).toContainText("replaces it with a valid store");
  // The list is empty and the population controls still work: creating a
  // profile writes the valid replacement directly.
  await page.getByRole("button", { name: "New profile" }).click();
  await page
    .getByRole("textbox", { name: "Profile name" })
    .fill("Recovery worker");
  await page
    .getByTestId("profile-provider-picker")
    .getByRole("button", { name: "Provider" })
    .click();
  await page.getByTestId("profile-option-anthropic").click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("profile-row-Recovery worker")).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test("Field errors reuse the store's schema rules", async ({ page }) => {
  await openProfiles(page);
  await openEditor(page, "Deep reviewer");
  const name = page.getByRole("textbox", { name: "Profile name" });
  await name.fill("inherit");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("profile-error-name")).toHaveText(
    '"inherit" and "tracked" are reserved.',
  );
  // The invalid draft does not save; the store keeps the original name.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("profile-error-name")).toHaveCount(0);
  await expect(name).toHaveValue("Deep reviewer");
});

test("A stale save keeps the edits and offers a reload", async ({ page }) => {
  await openProfiles(page, "/?profiles&profiles-stale");
  await openEditor(page, "Deep reviewer");
  await page.getByRole("textbox", { name: "Profile name" }).fill("Deep rev 2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const notice = page.getByTestId("profile-stale-notice");
  await expect(notice).toContainText(STALE_MESSAGE);
  await notice.getByRole("button", { name: "Reload profiles" }).click();
  await expect(page.getByTestId("profile-stale-notice")).toHaveCount(0);
});

test("The list stacks above the editor on narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 900 });
  await openProfiles(page);
  // The compact layout keeps the routing toggle row in the list header.
  await expect(page.getByTestId("profiles-mode-toggle")).toBeVisible();
  await page
    .getByRole("button", { name: "Edit profile: Deep reviewer" })
    .click();
  const list = page.getByTestId("profiles-queue");
  const editor = page.getByTestId("profile-editor");
  await expect(list).toBeVisible();
  await expect(editor).toBeVisible();
  const listBox = await list.boundingBox();
  const editorBox = await editor.boundingBox();
  if (!listBox || !editorBox) {
    throw new Error("Both columns should have a bounding box.");
  }
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(editorBox.y + 2);
});

test("The redesigned tab renders in the dark theme", async ({ page }) => {
  await openProfiles(page, "/?profiles&dark");
  // Cards, the inline warning, the toggle and the editor all compose from
  // theme tokens only, so the same markup stays readable on the dark surface.
  await expect(page.getByTestId("profiles-mode-toggle")).toBeVisible();
  await expect(
    page
      .getByTestId("profile-row-Unrouted helper")
      .getByTestId("profile-row-unclassified"),
  ).toContainText("Needs roles and size");
  await openEditor(page, "Deep reviewer");
  await expect(
    page.getByTestId("profile-editor-title").getByText("Deep reviewer"),
  ).toBeVisible();
  await expect(page.getByTestId("profile-segment-small").first()).toBeVisible();
});

test("A dirty draft is rejected stale after a background refresh (real query path)", async ({
  page,
}) => {
  await page.goto("/?profiles-real");
  // The real useProfiles hook serves this page; no preview stub involved.
  await page
    .getByRole("button", { name: "Edit profile: Deep reviewer" })
    .click();
  const instructions = page.getByRole("textbox", { name: "Instructions" });
  await instructions.fill("Local draft waited on for validation.");
  // Another client saves to the same store while this draft is dirty.
  await page.evaluate(() => {
    (
      window as unknown as { __profilesReal?: PreviewHandle }
    ).__profilesReal?.otherClientSaves("Deep reviewer", {
      instructions: "Remote hand edit survives.",
    });
  });
  // Background refresh via the real query path: the row now shows the
  // other client's change while the local draft is still unsaved.
  await page.waitForTimeout(5500);
  await page.evaluate(() => {
    // React Query refetches stale active queries when the window sees the
    // document become visible again; the event must bubble to reach it.
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  // The remote change reached the card while the local draft stayed intact.
  await expect(instructions).toHaveValue(
    "Local draft waited on for validation.",
  );
  // Saving sends the draft's stale base revision, so the server rejects it
  // instead of silently clobbering the remote change.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const notice = page.getByTestId("profile-stale-notice");
  await expect(notice).toContainText(STALE_MESSAGE);
  // The explicit reload re-anchors the draft's revision; the user's next
  // save reconciles deliberately.
  await notice.getByRole("button", { name: "Reload profiles" }).click();
  await expect(page.getByTestId("profile-stale-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("profile-saved-notice")).toContainText(
    "Profile saved.",
  );
  // Reopening the editor with a fresh mount shows the reconciled draft.
  await page
    .getByRole("button", { name: "Edit profile: Fast responder" })
    .click();
  await page
    .getByRole("button", { name: "Edit profile: Deep reviewer" })
    .click();
  await expect(instructions).toHaveValue(
    "Local draft waited on for validation.",
  );
});

test("Task cards and History render the stored profile name snapshot", async ({
  page,
}) => {
  await page.goto("/?symphonies&symphony-fixture=profile-snapshot");
  await page.getByRole("tab", { name: "Symphonies", exact: true }).click();
  const detail = page.getByTestId("symphony-detail");
  await page
    .getByRole("button", { name: "Open symphony: Routed pagination work" })
    .click();
  // The task's worker ref is now a stale id; the stored name snapshot shows.
  await expect(detail).toContainText("Task agent profile: Deep reviewer");
  await expect(detail.getByText(/Routed to aa100000/)).toHaveCount(0);
  await detail.getByRole("button", { name: "History" }).click();
  const firstAttempt = detail.getByTestId("history-task-api-loop-1");
  await expect(firstAttempt).toContainText("Routed to Deep reviewer");
});

test("The warning text passes AA on its opaque base plus wash, selected or not", async ({
  page,
}) => {
  for (const url of ["/?profiles", "/?profiles&dark"]) {
    for (const profile of ["Unrouted helper", "Legacy router"]) {
      await openProfiles(page, url);
      // Unselected: the selection tint is inactive.
      expect(await selectionTintOpacity(page, profile)).toBe("0");
      const unselected = await warningRatio(page, profile);
      expect(unselected).toBeGreaterThanOrEqual(4.5);
      // Selecting the card activates the accent tint under the warning row;
      // the warning's own opaque base keeps the ratio at AA regardless.
      await page
        .getByRole("button", { name: `Edit profile: ${profile}` })
        .click();
      expect(await selectionTintOpacity(page, profile)).toBe("0.12");
      const selected = await warningRatio(page, profile);
      expect(selected).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("The warning action (mouse) opens routing, scrolls it into view, and focuses a control", async ({
  page,
}) => {
  await openProfiles(page);
  await page.getByTestId("profile-fix-Unrouted helper").click();
  const editor = page.getByTestId("profile-editor");
  await expect(
    page.getByTestId("profile-editor-title").getByText("Unrouted helper"),
  ).toBeVisible();
  const heading = editor.getByText("Routing", { exact: true });
  const headingBox = await heading.boundingBox();
  if (!headingBox) {
    throw new Error("The Routing heading should be measurable.");
  }
  expect(headingBox.y).toBeGreaterThan(0);
  // A profile without roles focuses a role chip, inside the viewport.
  await expect(page.getByTestId("profile-role-exploration")).toBeFocused();
  const roleBox = await page
    .getByTestId("profile-role-exploration")
    .boundingBox();
  expect(roleBox?.y).toBeLessThan(900);
});

test("The warning action (keyboard) focuses the size control for a roles-only profile", async ({
  page,
}) => {
  await openProfiles(page);
  // Legacy router keeps roles but has no size: the size control takes focus.
  const action = page.getByTestId("profile-fix-Legacy router");
  await action.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("profile-editor-title").getByText("Legacy router"),
  ).toBeVisible();
  await expect(page.getByTestId("profile-segment-small")).toBeFocused();
});

test("The warning action re-anchors routing when the profile is already selected", async ({
  page,
}) => {
  await openProfiles(page);
  // Selecting the card first leaves the editor at the top of the form.
  await page
    .getByRole("button", { name: "Edit profile: Unrouted helper" })
    .click();
  await page.getByRole("textbox", { name: "Profile name" }).waitFor();
  await page.getByTestId("profile-fix-Unrouted helper").click();
  await expect(page.getByTestId("profile-role-exploration")).toBeFocused();
  const editor = page.getByTestId("profile-editor");
  const headingBox = await editor
    .getByText("Routing", { exact: true })
    .boundingBox();
  if (!headingBox) {
    throw new Error("The Routing heading should be measurable.");
  }
  expect(headingBox.y).toBeGreaterThan(0);
});

test("The warning action works on narrow widths with the list stacked above", async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 900 });
  await openProfiles(page);
  await page.getByTestId("profile-fix-Unrouted helper").click();
  await expect(
    page.getByTestId("profile-editor-title").getByText("Unrouted helper"),
  ).toBeVisible();
  // The list stays stacked above the focused routing control.
  await expect(page.getByTestId("profiles-queue")).toBeVisible();
  await expect(page.getByTestId("profile-role-exploration")).toBeFocused();
  const list = await page.getByTestId("profiles-queue").boundingBox();
  const role = await page.getByTestId("profile-role-exploration").boundingBox();
  if (!list || !role) {
    throw new Error("Both columns should be measurable.");
  }
  expect(list.y + list.height).toBeLessThanOrEqual(role.y + 2);
});

test("The selected card fills with the accent tint, not just the border", async ({
  page,
}) => {
  await openProfiles(page);
  const tint = page
    .getByTestId("profile-row-Deep reviewer")
    .getByTestId("profile-row-tint");
  // Before selection the wash renders at zero opacity.
  expect(
    await tint.evaluate((element) => getComputedStyle(element).opacity),
  ).toBe("0");
  await page
    .getByRole("button", { name: "Edit profile: Deep reviewer" })
    .click();
  // After selection the wash fills the card with the accent.
  expect(
    await tint.evaluate((element) => getComputedStyle(element).opacity),
  ).toBe("0.12");
  const selected = tint;
  const box = await selected.boundingBox();
  const card = await page
    .getByTestId("profile-row-Deep reviewer")
    .boundingBox();
  if (!box || !card) {
    throw new Error("The tint layer and card should have bounds.");
  }
  // The wash fills the card bounds (the 1px border sits outside it).
  expect(box.height).toBeGreaterThanOrEqual(card.height - 2);
  expect(box.width).toBeGreaterThanOrEqual(card.width - 2);
  expect(
    await selected.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe("rgb(36, 94, 152)");
  expect(
    await selected.evaluate((element) => getComputedStyle(element).opacity),
  ).toBe("0.12");
});

test("Sync to Paseo needs a selection, exports it, and returns focus to the trigger", async ({
  page,
}) => {
  await openProfiles(page);
  await page.getByTestId("profile-sync").click();
  const dialog = page.getByTestId("profile-sync-dialog");
  await expect(dialog).toBeVisible();
  // The fixture store's profiles are all unmatched in Paseo, so every row
  // plans a create; nothing is checked before the user picks one.
  const row = page.getByTestId("profile-sync-row-Fast responder");
  await expect(row).toContainText("New in Paseo");
  await expect(row).toHaveAttribute("aria-checked", "false");
  const confirm = page.getByTestId("profile-sync-confirm");
  await expect(confirm).toHaveText("Sync 0 profiles");
  await expect(confirm).toBeDisabled();
  // Selecting the one profile arms the confirm button.
  await row.click();
  await expect(row).toHaveAttribute("aria-checked", "true");
  await expect(confirm).toHaveText("Sync 1 profile");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  // The dialog closes, the panel reports the export, and focus is restored.
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("profiles-panel-notice")).toContainText(
    "Synced to Paseo: 1 created, 0 updated.",
  );
  await expect(page.getByTestId("profile-sync")).toBeFocused();
});

test("A stale sync keeps the dialog open on the refreshed plan (real query path)", async ({
  page,
}) => {
  await page.goto("/?profiles-real");
  await page.getByTestId("profile-sync").click();
  const dialog = page.getByTestId("profile-sync-dialog");
  const row = page.getByTestId("profile-sync-row-Fast responder");
  await expect(row).toBeVisible();
  // Another client saves to the store after the preview was computed, so the
  // confirm carries a revision that no longer matches.
  await page.evaluate(() => {
    (
      window as unknown as { __profilesReal?: PreviewHandle }
    ).__profilesReal?.otherClientSaves("Deep reviewer", {
      instructions: "Remote hand edit after the preview.",
    });
  });
  await row.click();
  await page.getByTestId("profile-sync-confirm").click();
  // The export writes nothing; the dialog stays open, redrawn from the fresh
  // preview the stale result returned, with the stale message shown.
  await expect(page.getByTestId("profile-sync-notice")).toContainText(
    "Profiles changed. Review and sync again.",
  );
  await expect(dialog).toBeVisible();
  await expect(row).toBeVisible();
});
