import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaintenanceService } from "../../server/cli-maintenance";
import {
  describeInstallation,
  inspectInstallation,
  parseVersion,
  updateInstallation,
  type Installation,
} from "../../server/cli-installation";
import { isNewerStable } from "../../shared/cli-maintenance";
import { run } from "../../server/cli-process";

const installation: Installation = {
  executable: "/example/bin/codex",
  resolvedPath: "/example/releases/1/codex",
  env: {},
  installed: "1.2.3",
  packageName: "@openai/codex",
  method: "Codex installer",
  updater: "/example/bin/codex",
  prefix: null,
};

test("version comparison avoids downgrade, prerelease replacement and lexicographic order", () => {
  assert.equal(isNewerStable("1.9.0", "1.10.0"), true);
  assert.equal(isNewerStable("2.0.0", "1.99.0"), false);
  assert.equal(isNewerStable("1.2.3", "1.2.3"), false);
  assert.equal(isNewerStable("1.2.3-beta.1", "1.2.3"), false);
  assert.equal(isNewerStable("1.2.3", "1.3.0; touch /tmp/example"), false);
  assert.equal(parseVersion("codex-cli 0.159.2"), "0.159.2");
  assert.equal(parseVersion("0.87.1"), "0.87.1");
  assert.throws(() => parseVersion("unknown"));
  assert.equal(
    describeInstallation("codex", { ...installation, updater: null }, "1.3.0")
      .canUpdate,
    false,
  );
});

test("check is read-only and simultaneous update requests cannot run twice", async () => {
  let updates = 0;
  let installed = "1.2.3";
  let finish = () => {};

  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = createMaintenanceService({
    inspect: async () => ({ ...installation, installed }),
    latest: async () => "1.3.0",
    update: async () => {
      updates++;
      await gate;
      installed = "1.3.0";
    },
  });
  assert.throws(() => service.update("codex", "1.3.0", async () => ({})));
  service.check(async () => ({}));
  await service.settled();
  assert.equal(updates, 0);
  assert.throws(() => service.update("codex", "99.0.0", async () => ({})));
  service.update("codex", "1.3.0", async () => ({}));
  assert.throws(() => service.update("codex", "1.3.0", async () => ({})));
  assert.throws(() => service.check(async () => ({})));
  finish();
  await service.settled();
  assert.equal(updates, 1);
  assert.equal(service.read().rows[0]?.installed, "1.3.0");
  assert.equal(service.read().rows[0]?.canUpdate, false);
  assert.equal(service.read().busy, false);
  service.close();
});

test("changed installations and failed configuration checks invalidate update offers", async () => {
  let changed = false;
  let updates = 0;
  const service = createMaintenanceService({
    inspect: async () => ({
      ...installation,
      resolvedPath: changed ? "/another/install" : installation.resolvedPath,
    }),
    latest: async () => "1.3.0",
    update: async () => {
      updates++;
    },
  });
  service.check(async () => ({}));
  await service.settled();
  changed = true;
  service.update("codex", "1.3.0", async () => ({}));
  await service.settled();
  assert.equal(updates, 0);
  assert.equal(service.read().rows[0]?.canUpdate, false);
  assert.match(service.read().message, /failed/);
  service.check(async () => {
    throw new Error("private configuration");
  });
  await service.settled();
  assert.throws(() => service.update("pi", "1.3.0", async () => ({})));
  assert.doesNotMatch(JSON.stringify(service.read()), /private configuration/);
  service.close();
});

test("one unavailable CLI or registry does not hide the other results", async () => {
  const service = createMaintenanceService({
    inspect: async (id) => {
      if (id === "pi") {
        throw new Error("secret");
      }

      return { ...installation, packageName: id };
    },
    latest: async (name) => {
      if (name === "opencode") {
        throw new Error("secret");
      }

      return "1.3.0";
    },
    update: async () => {},
  });
  service.check(async () => ({}));
  await service.settled();
  const { rows } = service.read();
  assert.equal(rows[0]?.canUpdate, true);
  assert.equal(rows[1]?.installed, "1.2.3");
  assert.equal(rows[1]?.latest, null);
  assert.equal(rows[2]?.installed, null);
  assert.doesNotMatch(JSON.stringify(rows), /secret/);
  service.close();
});

test("native update follows the stable launch path and verifies the resulting version", async () => {
  const calls: string[][] = [];
  await updateInstallation(
    installation,
    "1.3.0",
    new AbortController().signal,
    async (file, args) => {
      calls.push([file, ...args]);

      return args[0] === "--version" ? "codex-cli 1.3.0" : "";
    },
  );
  assert.deepEqual(calls, [
    [installation.executable, "update"],
    [installation.executable, "--version"],
  ]);
  await assert.rejects(() =>
    updateInstallation(
      installation,
      "1.3.0",
      new AbortController().signal,
      async () => "1.2.3",
    ),
  );
  await assert.rejects(() =>
    updateInstallation(
      installation,
      "1.1.0",
      new AbortController().signal,
      async () => {
        throw new Error("Must not run");
      },
    ),
  );
});

test("npm updates use the detected prefix and a fixed version argument", async () => {
  const npmInstallation = {
    ...installation,
    method: "npm",
    prefix: "/some node",
    updater: "/some node/bin/npm",
  };
  const calls: string[][] = [];
  await updateInstallation(
    npmInstallation,
    "1.3.0",
    new AbortController().signal,
    async (file, args) => {
      calls.push([file, ...args]);

      return args[0] === "--version" ? "1.3.0" : "";
    },
  );
  assert.deepEqual(calls[0], [
    "/some node/bin/npm",
    "install",
    "--global",
    "--prefix",
    "/some node",
    "@openai/codex@1.3.0",
    "--no-audit",
    "--no-fund",
  ]);
});

test("standalone detection retains the launcher symlink and rejects custom wrappers", async () => {
  const root = await mkdtemp(join(tmpdir(), "nestkit-cli-"));

  try {
    const dir = join(root, "packages", "standalone", "1.2.3", "bin");
    await mkdir(dir, { recursive: true });
    const binary = join(dir, "codex");
    const launcher = join(root, "codex");
    await writeFile(binary, "fixture", { mode: 0o755 });
    await symlink(binary, launcher);
    const detected = await inspectInstallation(
      "codex",
      { command: [launcher] },
      new AbortController().signal,
      async (_file, args) =>
        args[0] === "--version" ? "1.2.3" : "update Update Codex",
    );
    assert.equal(detected.executable, launcher);
    assert.equal(detected.resolvedPath, binary);
    assert.equal(detected.method, "Codex installer");
    await assert.rejects(
      () =>
        inspectInstallation(
          "codex",
          { command: ["wrapper", "codex"] },
          new AbortController().signal,
        ),
      /wrapper/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process failures hide output and cancellation stops waiting", async () => {
  await assert.rejects(
    () =>
      run(
        process.execPath,
        ["-e", "console.error('secret-token');process.exit(1)"],
        {},
        new AbortController().signal,
      ),
    (error: Error) => !error.message.includes("secret-token"),
  );
  const controller = new AbortController();
  const pending = run(
    process.execPath,
    ["-e", "setTimeout(()=>{},60000)"],
    {},
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /failed or timed out/);
});

test("model refresh shares the operation lock and reports the result", async () => {
  const service = createMaintenanceService();
  let finish = () => {};

  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  service.refresh("codex", async () => {
    await gate;

    return "8 models";
  });
  assert.throws(() => service.check(async () => ({})));
  finish();
  await service.settled();
  assert.equal(service.read().message, "8 models");
  service.close();
  assert.throws(() => service.refresh("codex", async () => ""));
});

test("process timeout and excessive output fail without waiting on installer children", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    () =>
      run(
        process.execPath,
        [
          "-e",
          "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});setTimeout(()=>{},60000)",
        ],
        {},
        signal,
        150,
      ),
    /failed or timed out/,
  );
  await assert.rejects(
    () =>
      run(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(1100000))"],
        {},
        signal,
      ),
    /failed or timed out/,
  );
});
