import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeInstallation,
  inspectInstallation,
  updateInstallation,
} from "../../server/cli-installation";
import { createMaintenanceService } from "../../server/cli-maintenance";
import { cliSchema } from "../../shared/cli-maintenance";

test("Claude native updates retain the launcher and install the offered version", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-maintenance-"));

  try {
    const versions = join(root, ".local/share/claude/versions");
    const bin = join(root, ".local/bin");
    await mkdir(versions, { recursive: true });
    await mkdir(bin, { recursive: true });
    const binary = join(versions, "2.1.0");
    const launcher = join(bin, "claude");
    await writeFile(binary, "fixture", { mode: 0o755 });
    await symlink(binary, launcher);
    const calls: string[][] = [];
    let installed = "2.1.0";
    const execute = async (file: string, args: string[]) => {
      calls.push([file, ...args]);

      if (args[0] === "install") {
        installed = "2.2.0";
      }

      return args[0] === "--version"
        ? `${installed} (Claude Code)`
        : "install [version] Install Claude Code";
    };

    const detected = await inspectInstallation(
      "claude",
      { command: [launcher] },
      new AbortController().signal,
      execute,
    );
    assert.equal(detected.method, "Claude Code installer");
    assert.equal(detected.resolvedPath, binary);
    assert.equal(detected.packageName, "@anthropic-ai/claude-code");
    assert.equal(
      describeInstallation("claude", detected, "2.2.0").canUpdate,
      true,
    );
    calls.length = 0;
    await updateInstallation(
      detected,
      "2.2.0",
      new AbortController().signal,
      execute,
    );
    assert.deepEqual(calls, [
      [launcher, "install", "2.2.0"],
      [launcher, "--version"],
    ]);
    await assert.rejects(() =>
      updateInstallation(
        detected,
        "2.3.0",
        new AbortController().signal,
        async () => "2.1.0 (Claude Code)",
      ),
    );
    await assert.rejects(
      () =>
        inspectInstallation(
          "claude",
          { command: ["wrapper", launcher] },
          new AbortController().signal,
          execute,
        ),
      /wrapper/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [packageName, nested] of [
  ["@anthropic-ai/claude-code", false],
  ["@anthropic-ai/claude-code-linux-x64", false],
  ["@anthropic-ai/claude-code-linux-x64", true],
] as const) {
  test(`Claude npm detection and updates use the CLI package for ${packageName} (nested: ${nested})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-npm-"));

    try {
      const modules = join(root, "lib/node_modules");
      const cliDirectory = join(modules, "@anthropic-ai/claude-code");
      const directory = join(
        nested ? join(cliDirectory, "node_modules") : modules,
        packageName,
      );
      const bin = join(root, "bin");
      await mkdir(directory, { recursive: true });
      await mkdir(bin, { recursive: true });

      if (nested) {
        await writeFile(
          join(cliDirectory, "package.json"),
          JSON.stringify({ name: "@anthropic-ai/claude-code" }),
        );
      }

      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: packageName }),
      );
      const binary = join(directory, "claude");
      const launcher = join(bin, "claude");
      const npm = join(bin, "npm");
      await writeFile(binary, "fixture", { mode: 0o755 });
      await writeFile(npm, "fixture", { mode: 0o755 });
      await symlink(binary, launcher);
      const detected = await inspectInstallation(
        "claude",
        { command: [launcher] },
        new AbortController().signal,
        async (_file, args) =>
          args[0] === "root" ? modules : "2.1.0 (Claude Code)",
      );
      assert.equal(detected.method, "npm");
      assert.equal(detected.prefix, root);
      const calls: string[][] = [];
      await updateInstallation(
        detected,
        "2.2.0",
        new AbortController().signal,
        async (file, args) => {
          calls.push([file, ...args]);

          return "2.2.0 (Claude Code)";
        },
      );
      assert.deepEqual(calls[0], [
        npm,
        "install",
        "--global",
        "--prefix",
        root,
        "@anthropic-ai/claude-code@2.2.0",
        "--no-audit",
        "--no-fund",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("unrecognized Claude installations are visible without an automatic update", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-manual-"));

  try {
    const binary = join(root, "claude");
    await writeFile(binary, "fixture", { mode: 0o755 });
    const detected = await inspectInstallation(
      "claude",
      { command: [binary] },
      new AbortController().signal,
      async () => "2.1.0 (Claude Code)",
    );
    assert.equal(detected.method, "Manual");
    const row = describeInstallation("claude", detected, "2.2.0");
    assert.equal(row.canUpdate, false);
    assert.match(row.message, /original installation manager/);
    assert.equal(cliSchema.parse("claude"), "claude");
    const service = createMaintenanceService({
      inspect: async () => detected,
      latest: async (name) => {
        assert.equal(name, "@anthropic-ai/claude-code");

        return "2.2.0";
      },
      update: async () => assert.fail("read-only check"),
    });
    service.check(async () => ({}));
    await service.settled();
    assert.deepEqual(
      service.read().rows.find((entry) => entry.id === "claude"),
      row,
    );
    service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
