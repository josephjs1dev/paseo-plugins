// This dependency-free CLI is emitted beside the socket so Git-installed plugins
// do not need a separate SDK installation in the agent's shell environment.
export const SYMPHONY_COMMAND_SOURCE = String.raw`import http from "node:http";

const help = {
  usage: 'node "$CONDUCTOR_COMMAND" <command> [--agent ID] [--socket PATH] < input.json',
  commands: {
    orchestrate: { key: "stable-request-key", title: "Deliver a feature", goal: "Authorized work to split among agents", concurrency: 3, conductor: "self (default; follow the returned instructions) or agent (create a dedicated Conductor agent)", conductorProfile: "optional configured profile name; implies conductor agent" },
    profiles: "List configured worker profiles: id, name, notes, provider, model, modeId, thinkingOptionId",
    models: "List available providers and model IDs for per-task worker choice",
    define: { symphonyId: "UUID", tasks: "[{id,title,description,dependsOn:[],reads:[\".\"],writes:[],checks:[],profile:optional configured name, or provider/model/thinkingOptionId:optional inline choice; never both}]" },
    dispatch: { symphonyId: "UUID", retryTaskId: "optional settled blocked/failed task ID", note: "optional guidance for the resumed task agent; requires retryTaskId", addWrites: "optional checkout-relative paths to add to the task's write scope; requires retryTaskId", profile: "optional replacement profile for a failed task retry", provider: "or inline replacement provider", model: "or inline replacement model", thinkingOptionId: "optional inline replacement thinking option" },
    start: { key: "stable-task-key", title: "Fix the toolbar", goal: "Describe the authorized work", tasks: "optional [{id,title,description,dependsOn:[],reads:[\".\"],writes:[\".\"],checks:[]}]" },
    list: "No input required",
    get: { symphonyId: "UUID" },
    claim: { symphonyId: "UUID", taskId: "work", retry: false },
    block: { symphonyId: "UUID", attemptId: "UUID from claim", message: "Describe the blocker; ask the user in the source conversation" },
    report: { symphonyId: "UUID", attemptId: "UUID from claim", report: { outcome: "completed or failed", summary: "What happened", evidence: ["Concrete change or check evidence"], checks: [{ name: "exact declared check name", status: "passed, failed or not-run", detail: "Observed result" }], diagnosis: "optional on failed reports: {tried, suspectedCause, need: scope|input|model|none, requestedWrites}" } },
    widen: { symphonyId: "UUID", attemptId: "UUID from your assignment", paths: ["shared/schema.ts"], reason: "Why your change needs these files", example: "printf '%s' '{\"symphonyId\":\"<symphony UUID>\",\"attemptId\":\"<attempt UUID>\",\"paths\":[\"shared/schema.ts\"],\"reason\":\"<why the change needs it>\"}' | node \"$CONDUCTOR_COMMAND\" widen --agent \"$CONDUCTOR_AGENT_ID\" --socket \"$CONDUCTOR_SOCKET\"" },
    finish: { symphonyId: "UUID", summary: "Overall outcome and remaining limitations" }
  },
  policy: "Start only for authorized work. Claim before working; keep the returned attempt ID. Work with your normal tools. Report explicit evidence; never infer completion from idle. Finish only after all tasks have completed reports. symphonyId identifies a symphony. The local socket trusts the daemon OS user; source IDs are checked against Paseo. Orchestrate makes the caller its Conductor agent by default, or a dedicated Conductor agent with conductor:\"agent\"; define records its decomposition; dispatch creates real task agents; profiles and models list worker choices. Source-only start/claim is supported. widen grows a running assignment's write scope after a server conflict check; it refuses paths held by another task or reader. No command grants new permissions. Reuse the same start key after an uncertain response. Resume unfinished work by claiming the same task; retry:true is only for an explicitly failed attempt."
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
  let input = "";
  if (kind !== "list" && kind !== "profiles" && kind !== "models") {
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 262144) throw new Error("Command input exceeds 256 KiB.");
    }
  }
  let fields;
  try { fields = input.trim() ? JSON.parse(input) : {}; } catch { throw new Error("Command input must be valid JSON."); }
  if (!fields || Array.isArray(fields) || typeof fields !== "object" || "kind" in fields) throw new Error("Input must be an object without a kind field.");
  const body = JSON.stringify({ agentId, command: { kind, ...fields } });
  const result = await new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: "/command", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk.toString();
        if (Buffer.byteLength(data) > 2200000) { response.destroy(); reject(new Error("Command response exceeds its limit.")); }
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (response.statusCode !== 200) reject(new Error(parsed.error || "Conductor command failed."));
          else resolve(parsed);
        } catch { reject(new Error("Conductor returned an invalid response.")); }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error("Command acknowledgement is uncertain. Inspect the symphony before retrying; reuse its start key/attempt identity.")));
    request.on("error", (error) => reject(new Error(error.code ? "Conductor command connection failed (" + error.code + "). Check the plugin or refresh the agent session." : error.message)));
    request.end(body);
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
`;
