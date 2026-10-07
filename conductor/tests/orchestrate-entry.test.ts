import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type {
  PluginClientSlashCommandContribution,
  PluginWorkspaceCommandContext,
} from "@getpaseo/plugin/client";
import { registerOrchestrate } from "../client/orchestrate";
import { orchestrateRun } from "../shared/run-rpc";
import { storedRun } from "./run-fixtures";

for (const legacy of [false, true]) {
  void test(`new-agent draft retries with the same identity on ${legacy ? "legacy surfaces" : "modern screens"}`, async () => {
    const commands: PluginClientSlashCommandContribution[] = [];
    registerOrchestrate({
      addSlashCommand(command) {
        commands.push(command);
        return () => {};
      },
    });
    const command = commands.find(
      (value) =>
        value.name === "conductor-orchestrate" && value.context === "workspace",
    );
    assert.ok(
      command?.context === "workspace",
      "The draft composer only exposes workspace commands",
    );
    const requests: z.infer<typeof orchestrateRun.input>[] = [];
    let fail = true;
    const base = storedRun();
    const run = {
      ...base,
      status: "planning",
      draft: null,
      revisions: [],
      execution: {
        origin: "orchestrator",
        attempts: [],
        summary: null,
        finishedAt: null,
        interruption: null,
        orchestration: {
          phase: "planning",
          concurrency: 3,
          requestedBy: null,
          coordinatorLaunch: "started",
          prompt: "Plan the work",
          notification: null,
        },
      },
    };
    const screens: unknown[] = [];
    const surfaces: string[] = [];
    const context: PluginWorkspaceCommandContext & { args: string } = {
      context: "workspace",
      args: "Verify the workspace entry",
      workspace: {
        id: "ws-api",
        projectId: "project-1",
        projectDisplayName: "Conductor",
        projectRootPath: "/test/repo",
        directory: "/test/repo",
        projectKind: "git",
        kind: "local_checkout",
        name: "Conductor",
        title: null,
        status: "done",
        statusEnteredAt: null,
        archivingAt: null,
        diffStat: null,
      },
      get paseo(): never {
        throw new Error(
          "The draft must not find or create a placeholder agent via the client SDK",
        );
      },
      async rpc(contract, input) {
        requests.push(orchestrateRun.input.parse(input));
        if (fail) {
          fail = false;
          throw new Error("Acknowledgement lost");
        }
        return z.parse(contract.output, { run });
      },
      openScreen(input) {
        screens.push(input);
      },
      openSurface(id) {
        surfaces.push(id);
      },
      openSettings() {},
      openPanel() {},
    };
    if (legacy) {
      // The supported 0.10 runtime lacks this property; SDK types describe 0.11.
      Reflect.deleteProperty(context, "openScreen");
    }
    context.args = "   ";
    await assert.rejects(
      async () => command.onSubmit(context),
      /Describe the work/,
    );
    context.args = "Verify the workspace entry";
    await assert.rejects(
      async () => command.onSubmit(context),
      /Acknowledgement lost/,
    );
    await command.onSubmit(context);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.ok(requests[0] && "workspaceId" in requests[0]);
    assert.equal(requests[0].workspaceId, "ws-api");
    assert.equal("agentId" in requests[0], false);
    await command.onSubmit(context);
    assert.notEqual(requests[2]?.key, requests[1]?.key);
    if (legacy) {
      assert.deepEqual(surfaces, Array<string>(5).fill("podium"));
      assert.equal(screens.length, 0);
    } else {
      assert.deepEqual(screens.at(-1), {
        screenId: "inbox",
        params: { runId: base.id },
      });
      assert.equal(surfaces.length, 0);
    }
  });
}
