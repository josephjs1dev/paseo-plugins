import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSymphony } from "../shared/symphonies/models";
import {
  OTHER_SYMPHONIES,
  listWithProjects,
  withProjectNames,
} from "../server/symphonies/projects";
import { fixtureSymphonyId, storedSymphony } from "./symphony-fixtures";

function summary(concertId: string, id: string = fixtureSymphonyId) {
  const symphony = storedSymphony();
  symphony.id = id;
  symphony.source.concertId = concertId;
  return summarizeSymphony(symphony);
}

const symphonyIds = {
  api: "f1151538-5302-4fbf-b50b-f6a55f2a5b01",
  ui: "f1151538-5302-4fbf-b50b-f6a55f2a5b02",
  docs: "f1151538-5302-4fbf-b50b-f6a55f2a5b03",
  gone: "f1151538-5302-4fbf-b50b-f6a55f2a5b04",
};

function storage(
  symphonies: ReturnType<typeof summary>[],
  coverage = { unavailable: 3, incomplete: true },
) {
  return { symphonies, ...coverage };
}

void test("a listed symphony carries its source concert's live project name", () => {
  const entries = withProjectNames(
    [summary("ws-api")],
    [{ id: "ws-api", name: "Conductor concert", projectName: "Northwind" }],
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.projectName, "Northwind");
  assert.equal(entries[0]?.source.concertId, "ws-api");
});

void test("a symphony whose concert is absent groups under the other fallback", () => {
  const entries = withProjectNames(
    [summary("ws-gone")],
    [{ id: "ws-api", name: "Conductor concert", projectName: "Northwind" }],
  );
  assert.equal(entries[0]?.projectName, OTHER_SYMPHONIES);
});

void test("an unreadable concert directory keeps every symphony and its storage metadata", async () => {
  const result = await listWithProjects(
    () =>
      Promise.resolve(
        storage(
          [
            summary("ws-api", symphonyIds.api),
            summary("ws-gone", symphonyIds.gone),
          ],
          { unavailable: 0, incomplete: false },
        ),
      ),
    () => Promise.reject(new Error("concert directory unavailable")),
  );
  assert.deepEqual(
    result.symphonies.map((entry) => entry.projectName),
    [OTHER_SYMPHONIES, OTHER_SYMPHONIES],
  );
  assert.deepEqual(
    result.symphonies.map((entry) => entry.id),
    [symphonyIds.api, symphonyIds.gone],
  );
  // A cosmetic directory failure must not be reported as missing storage.
  assert.equal(result.unavailable, 0);
  assert.equal(result.incomplete, false);
});

void test("concertId keeps only the symphonies from that concert", async () => {
  const result = await listWithProjects(
    () =>
      Promise.resolve(
        storage([
          summary("ws-api", symphonyIds.api),
          summary("ws-other", symphonyIds.ui),
          summary("ws-api", symphonyIds.docs),
        ]),
      ),
    () => Promise.resolve([]),
    "ws-api",
  );
  assert.deepEqual(
    result.symphonies.map((entry) => entry.id),
    [symphonyIds.api, symphonyIds.docs],
  );
});

void test("listed order is preserved across mixed projects", async () => {
  const result = await listWithProjects(
    () =>
      Promise.resolve(
        storage([
          summary("ws-a", symphonyIds.api),
          summary("ws-b", symphonyIds.ui),
          summary("ws-a", symphonyIds.docs),
          summary("ws-gone", symphonyIds.gone),
        ]),
      ),
    () =>
      Promise.resolve([
        { id: "ws-a", name: "Conductor concert", projectName: "Northwind" },
        { id: "ws-b", name: "Other concert", projectName: "Contoso" },
      ]),
  );
  assert.deepEqual(
    result.symphonies.map((entry) => entry.id),
    [symphonyIds.api, symphonyIds.ui, symphonyIds.docs, symphonyIds.gone],
  );
  assert.deepEqual(
    result.symphonies.map((entry) => entry.projectName),
    ["Northwind", "Contoso", "Northwind", OTHER_SYMPHONIES],
  );
});

void test("a storage failure propagates instead of returning a partial list", async () => {
  await assert.rejects(
    listWithProjects(
      () => Promise.reject(new Error("symphony storage unavailable")),
      () => Promise.resolve([]),
    ),
    /symphony storage unavailable/,
  );
});
