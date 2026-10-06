import type { PluginClientContext } from "@getpaseo/plugin/client";
import { orchestrateRun } from "../shared/run-rpc";
import { openInbox } from "./registration";

export function registerOrchestrate(
  client: Pick<PluginClientContext, "addSlashCommand">,
) {
  // Keep the request identity after a failed/uncertain acknowledgement. A successful
  // subsequent submission is a new request, even when the user's text is identical.
  const pending = new Map<string, string>();
  let sequence = 0;
  return client.addSlashCommand({
    name: "conductor-orchestrate",
    description: "Split work into tasks and dispatch a team of agents",
    argumentHint: "<what you want done>",
    context: "workspace",
    async onSubmit(context) {
      const { args, workspace } = context;
      const goal = args.trim();
      if (!goal) {
        throw new Error("Describe the work after /conductor-orchestrate.");
      }
      const request = JSON.stringify([workspace.id, goal]);
      const key =
        pending.get(request) ?? `${workspace.id}:${Date.now()}:${++sequence}`;
      pending.set(request, key);
      openInbox(context, { section: "runs" });
      const { run } = await context.rpc(orchestrateRun, {
        workspaceId: workspace.id,
        key,
        goal,
      });
      openInbox(context, { runId: run.id });
      if (run.execution?.orchestration?.coordinatorLaunch === "started") {
        pending.delete(request);
      }
    },
  });
}
