import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSymphony } from "../shared/symphonies/models";
import {
  OTHER_SYMPHONIES,
  withProjectNames,
} from "../server/symphonies/projects";
import { storedSymphony } from "./symphony-fixtures";

function summary(concertId: string) {
  const symphony = storedSymphony();
  symphony.source.concertId = concertId;
  return summarizeSymphony(symphony);
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

void test("an unreadable or empty concert directory keeps every symphony", () => {
  const entries = withProjectNames([summary("ws-api"), summary("ws-gone")], []);
  assert.deepEqual(
    entries.map((entry) => entry.projectName),
    [OTHER_SYMPHONIES, OTHER_SYMPHONIES],
  );
});
