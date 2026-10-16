import { COMMAND_REQUEST_SOURCE } from "./request-source";
import { MCP_SOURCE } from "./mcp-source";

// This dependency-free CLI is emitted beside the socket so Git-installed plugins
// do not need a separate SDK installation in the agent's shell environment.
export const SYMPHONY_COMMAND_SOURCE = String.raw`import http from "node:http";
${COMMAND_REQUEST_SOURCE}
${MCP_SOURCE}

const help = {
  usage: 'node "$CONDUCTOR_COMMAND" <command> [--agent ID] [--socket PATH] < input.json',
  commands: {
    orchestrate: { key: "stable-request-key", title: "Deliver a feature", goal: "Authorized work to split among agents", concurrency: 3, maxLoops: "optional loop budget 1-5, default 3", conductor: "self (default; follow the returned instructions) or agent (create a dedicated Conductor agent)", conductorProfile: "optional configured profile name; implies conductor agent" },
    profiles: "List combined worker profiles and routing: id, name, notes, provider, model, modeId, thinkingOptionId, classification and routing",
    models: "List available providers and model IDs for per-task worker choice",
    route: { role: "exploration, implementation, planning or review", "profile|provider/model/thinkingOptionId": "optional explicit worker choice to validate" },
    define: { symphonyId: "UUID", tasks: "[{id,title,description,dependsOn:[],reads:[\".\"],writes:[],checks:[],review:optional true for a read-only review,role:optional routing role,openDecision:required for role planning,profile:optional configured name, or provider/model/thinkingOptionId:optional inline choice; never both,routing:optional {reason,override:{category,evidence}}}]" },
    loop: { symphonyId: "UUID", reason: "Why this loop", reopen: "optional [{taskId,findings:['review#F1'],note:optional,addWrites:optional,after:optional loop-only prerequisites,profile:optional worker override, or provider/model/thinkingOptionId:optional inline override,routing:required with a worker override: {reason,override:{category,evidence}}}]" , tasks: "optional new tasks appended in a new score revision; each takes the same routing fields as define", deferred: "optional [{finding|taskId, reason}] for open items you are not reopening", approval: "required past the loop budget: {loops, userAnswer}" },
    dispatch: { symphonyId: "UUID", retryTaskId: "optional settled blocked/failed task ID (not a needs-changes task)", note: "optional guidance for the resumed task agent; requires retryTaskId", addWrites: "optional checkout-relative paths to add to the task's write scope; requires retryTaskId", profile: "optional replacement profile for a failed task retry", provider: "or inline replacement provider", model: "or inline replacement model", thinkingOptionId: "optional inline replacement thinking option", routing: "required with a replacement worker: {reason,override:{category,evidence}}" },
    start: { key: "stable-task-key", title: "Fix the toolbar", goal: "Describe the authorized work", tasks: "optional [{id,title,description,dependsOn:[],reads:[\".\"],writes:[\".\"],checks:[]}]" },
    list: "No input required",
    get: { symphonyId: "UUID" },
    claim: { symphonyId: "UUID", taskId: "work", retry: false },
    block: { symphonyId: "UUID", attemptId: "UUID from claim", message: "Describe the blocker; ask the user in the source conversation" },
    report: { symphonyId: "UUID", attemptId: "UUID from claim", report: { outcome: "completed, needs-changes or failed", summary: "What happened", evidence: ["Concrete change or check evidence"], checks: [{ name: "exact declared check name", status: "passed, failed or not-run", detail: "Observed result" }], findings: "needs-changes or review: [{id,severity:blocking|minor,taskId,paths,summary,suggestedFix}] (taskId only from a review)", diagnosis: "optional on failed reports: {tried, suspectedCause, need: scope|input|model|harness, requestedWrites}" } },
    widen: { symphonyId: "UUID", attemptId: "UUID from your assignment", paths: ["shared/schema.ts"], reason: "Why your change needs these files", example: "printf '%s' '{\"symphonyId\":\"<symphony UUID>\",\"attemptId\":\"<attempt UUID>\",\"paths\":[\"shared/schema.ts\"],\"reason\":\"<why the change needs it>\"}' | node \"$CONDUCTOR_COMMAND\" widen --agent \"$CONDUCTOR_AGENT_ID\" --socket \"$CONDUCTOR_SOCKET\"" },
    finish: { symphonyId: "UUID", summary: "Overall outcome and remaining limitations", unresolved: "optional [{finding|taskId, reason}] covering every open finding and non-completed task when the user chose to stop; ends the symphony failed" }
  },
  policy: "Start only for authorized work. Claim before working; keep the returned attempt ID. Work with your normal tools. Report explicit evidence; never infer completion from idle. A failing check reports needs-changes, not failed; failed is only a harness problem. Finish only after all tasks have completed, or with unresolved after the user chose to stop. symphonyId identifies a symphony. The local socket trusts the daemon OS user; source IDs are checked against Paseo. Orchestrate makes the caller its Conductor agent by default, or a dedicated Conductor agent with conductor:\"agent\"; define records its decomposition; dispatch creates real task agents; loop reopens the owning tasks in a new loop inside the same symphony; profiles, route and models list and preview worker choices. Route each task to the smallest eligible configured profile for its role; when none is eligible set an explicit profile, provider/model, or profile \"inherit\" with routing.reason. Give every task routing.reason and escalate only with a specific routing.override category and evidence. Source-only start/claim is supported. widen grows a running assignment's write scope after a server conflict check; it refuses paths held by another task or reader. No command grants new permissions. Reuse the same start key after an uncertain response. Resume unfinished work by claiming the same task; retry:true is only for an explicitly failed attempt."
};

async function main() {
  const args = process.argv.slice(2);
  const kind = args.shift();
  if (!kind || kind === "help" || kind === "--help") { console.log(JSON.stringify(help, null, 2)); return; }
  let agentId = process.env.CONDUCTOR_AGENT_ID;
  let socketPath = process.env.CONDUCTOR_SOCKET;
  while (args.length) {
    const flag = args.shift(); const value = args.shift();
    if (!value || (flag !== "--agent" && flag !== "--socket")) throw new Error("Use --agent ID or --socket PATH after the command.");
    if (flag === "--agent") agentId = value; else socketPath = value;
  }
  if (!agentId || !socketPath) throw new Error("Missing Conductor source identity or socket. Use a new agent session or supply --agent and --socket.");
  if (kind === "mcp") {
    if (process.argv.length !== 3) throw new Error("MCP identity must come from its bound launcher, not command-line overrides.");
    await serveMcp(agentId, socketPath); return;
  }
  let input = "";
  if (kind !== "list" && kind !== "profiles" && kind !== "models") {
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > commandLimits.inputBytes) throw new Error("Command input exceeds 256 KiB.");
    }
  }
  let fields;
  try { fields = input.trim() ? JSON.parse(input) : {}; } catch { throw new Error("Command input must be valid JSON."); }
  if (!fields || Array.isArray(fields) || typeof fields !== "object" || "kind" in fields) throw new Error("Input must be an object without a kind field.");
  const result = await requestCommand(agentId, socketPath, { kind, ...fields });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
`;
