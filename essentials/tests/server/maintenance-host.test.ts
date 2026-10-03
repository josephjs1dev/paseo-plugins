import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readHostIdentity } from "../../server/maintenance-host";

test("host identity uses the daemon's persisted ID read-only and honors its override", async () => {
  const home = await mkdtemp(join(tmpdir(), "nestkit-host-"));
  const path = join(home, "server-id");

  try {
    await writeFile(path, "srv_existing\n");
    assert.deepEqual(
      await readHostIdentity({ PASEO_HOME: home }, "remote.local"),
      {
        id: "srv_existing",
        name: "remote.local",
      },
    );
    assert.deepEqual(
      await readHostIdentity(
        { PASEO_HOME: home, PASEO_SERVER_ID: " srv_override " },
        "remote.local",
      ),
      { id: "srv_override", name: "remote.local" },
    );
    assert.equal(await readFile(path, "utf8"), "srv_existing\n");
    assert.deepEqual(await readdir(home), ["server-id"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("missing or malformed identity is unavailable, never created or exposed in errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "nestkit-host-"));
  const unavailable = {
    message: "Could not identify this host. Check the host connection.",
  };

  try {
    await assert.rejects(
      readHostIdentity({ PASEO_HOME: home }, "remote"),
      unavailable,
    );
    assert.deepEqual(await readdir(home), []);
    await writeFile(join(home, "server-id"), "private invalid data");
    await assert.rejects(
      readHostIdentity({ PASEO_HOME: home }, "remote"),
      unavailable,
    );
    await assert.rejects(
      readHostIdentity({ PASEO_HOME: home, PASEO_SERVER_ID: "srv_ok" }, ""),
      unavailable,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
