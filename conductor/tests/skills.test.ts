import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ORCHESTRATE_SKILL } from "../server/skills/conductor-orchestrate";
import { installSkills, removeSkills } from "../server/skills/install";
import { registerSkillCommands } from "../client/skills";
import { testDirectory } from "./fixtures";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const skillPaths = (home: string) =>
  [".claude", ".agents"].map((dir) =>
    join(home, dir, "skills", "conductor-orchestrate"),
  );

void test("the skill names itself and documents symphonyId", () => {
  assert.match(
    ORCHESTRATE_SKILL,
    /^---\nname: conductor-orchestrate\ndescription: \S/,
  );
  assert.match(ORCHESTRATE_SKILL, /symphonyId/);
  // Bracketed so this guard against the old names does not itself trip the
  // repository-wide stale-name grep.
  assert.equal(/r[u]nId/.test(ORCHESTRATE_SKILL), false);
  assert.equal(/p[e]rformance/i.test(ORCHESTRATE_SKILL), false);
  assert.equal(ORCHESTRATE_SKILL.includes("\\`"), false);
});

void test("the skill lists profiles and models before splitting and teaches the task contract", () => {
  const options = ORCHESTRATE_SKILL.indexOf("List profiles and models");
  const split = ORCHESTRATE_SKILL.indexOf("Split the goal into tasks");
  assert.ok(options >= 0 && options < split);
  assert.match(ORCHESTRATE_SKILL, /Objective:/);
});

void test("the skill directs recovery from diagnosis and reviews granted writes", () => {
  assert.match(ORCHESTRATE_SKILL, /per-task notification summary first/);
  assert.match(ORCHESTRATE_SKILL, /diagnosis\.need/);
  assert.match(ORCHESTRATE_SKILL, /addWrites/);
  assert.match(ORCHESTRATE_SKILL, /different worker choice only for/);
  assert.match(ORCHESTRATE_SKILL, /grantedWrites/);
  assert.match(ORCHESTRATE_SKILL, /Widen refused/);
});

void test("install writes both copies, refreshes them, and remove deletes only Conductor copies", async () => {
  const home = await testDirectory();
  const paths = skillPaths(home);
  assert.deepEqual(await installSkills(home), { changed: paths, skipped: [] });
  for (const path of paths) {
    assert.equal(
      await readFile(join(path, "SKILL.md"), "utf8"),
      ORCHESTRATE_SKILL,
    );
    assert.equal(await exists(join(path, ".paseo-conductor")), true);
  }
  await writeFile(join(paths[0] ?? "", "SKILL.md"), "stale");
  assert.deepEqual(await installSkills(home), { changed: paths, skipped: [] });
  assert.equal(
    await readFile(join(paths[0] ?? "", "SKILL.md"), "utf8"),
    ORCHESTRATE_SKILL,
  );
  assert.deepEqual(await removeSkills(home), { changed: paths, skipped: [] });
  for (const path of paths) {
    assert.equal(await exists(path), false);
  }
  assert.deepEqual(await removeSkills(home), { changed: [], skipped: [] });
});

void test("a skill of the same name that Conductor did not install is never changed", async () => {
  const home = await testDirectory();
  const [own, foreign] = skillPaths(home);
  assert.ok(own && foreign);
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "SKILL.md"), "mine");
  assert.deepEqual(await installSkills(home), {
    changed: [own],
    skipped: [foreign],
  });
  assert.deepEqual(await removeSkills(home), {
    changed: [own],
    skipped: [foreign],
  });
  assert.equal(await readFile(join(foreign, "SKILL.md"), "utf8"), "mine");
});

void test("Command Center items install and remove the skill and surface skipped copies", async () => {
  const items: Array<{
    id: string;
    context: string;
    onSelect(context: unknown): void | Promise<void>;
  }> = [];
  const removers = registerSkillCommands({
    addCommandCenterItem: (item) => {
      items.push(item as (typeof items)[number]);
      return () => {};
    },
  });
  assert.equal(removers.length, 2);
  assert.deepEqual(
    items.map(({ id, context }) => [id, context]),
    [
      ["install-conductor-skills", "global"],
      ["remove-conductor-skills", "global"],
    ],
  );
  const calls: string[] = [];
  const select = (index: number, skipped: string[]) =>
    items[index]?.onSelect({
      rpc: (contract: { name: string }) => {
        calls.push(contract.name);
        return Promise.resolve({ changed: [], skipped });
      },
    });
  await select(0, []);
  await select(1, []);
  await assert.rejects(
    Promise.resolve(select(0, ["/home/.agents/skills/conductor-orchestrate"])),
    /left existing skills unchanged/,
  );
  assert.deepEqual(calls, [
    "skills.install",
    "skills.remove",
    "skills.install",
  ]);
});
