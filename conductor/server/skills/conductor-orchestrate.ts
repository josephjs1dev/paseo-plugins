// Embedded so Git and npm installs need no extra files or dev dependencies.
export const ORCHESTRATE_SKILL = `---
name: conductor-orchestrate
description: Turn an approved plan or request into a Paseo Conductor concert from this session. Split it into tasks, choose a configured profile or model per task (implement, explore, plan, review), dispatch worker agents, track their reports, and finish with a summary. Use when the user says "orchestrate", "conductor", "concert", "split this into tasks", "dispatch agents", "run this plan with agents", or asks to parallelize work across agents. Requires the Paseo Conductor plugin. Do not use it to create a dedicated Conductor agent.
---

# Conductor orchestrate

This session is the Conductor. You plan, dispatch, review and finish. Worker agents do the task work. Do not create a dedicated Conductor agent.

## Terms

| Term | Meaning |
|---|---|
| Concert | One orchestration: this Conductor session plus its task agents, as shown in the Podium. |
| \`concertId\` | The concert ID: a UUID that \`orchestrate\` returns. |
| Task | One bounded assignment for one worker agent. |
| Attempt | One worker's try at a task. A retry of a failed task creates a new attempt. |
| Worker | A child agent that Conductor creates for a task. |

## Find the helper

1. Use the helper command in the \`[Conductor agent commands]\` system instructions, for example \`node '/…/agent-commands/<agent-id>.mjs'\`. It carries this agent's identity and the daemon socket.
2. If that block is missing, use \`node "$CONDUCTOR_COMMAND"\`.
3. If neither exists, stop. Tell the user to enable the Conductor plugin in Paseo and start a new agent.

Send JSON input on stdin, never as an argument:

\`\`\`bash
node '<helper>' orchestrate <<'JSON'
{"key":"inline-worker-choice","title":"Add inline worker choice","goal":"..."}
JSON
\`\`\`

Every successful command prints a JSON acknowledgement. Empty output is a failure. Run \`node '<helper>' help\` for the full command list.

## Workflow

### 1. Confirm the goal

- Use the approved plan from this conversation, or the user's request.
- Ask only if the scope or the authorized actions are unclear.
- Do not orchestrate a small edit. Do it yourself, unless the user asks for a concert.

### 2. Start the concert

\`orchestrate\` input:

- \`key\`: a stable request key, such as \`inline-worker-choice\`. Reuse the same key after an empty or uncertain response. A repeated key returns the same concert, not a second one.
- \`title\`: 160 characters or fewer.
- \`goal\`: 16000 characters or fewer. Include the plan, the constraints and the acceptance criteria.
- \`concurrency\`: optional, 1–4, default 3.
- Do not set \`coordinator\` or \`coordinatorProfile\`.

Keep the returned \`concertId\`. Read the returned \`instructions\`. If they differ from this skill, follow the instructions.

### 3. List the worker options

Run \`profiles\` and \`models\` before you split the goal:

\`\`\`bash
node '<helper>' profiles <<'JSON'
{}
JSON
node '<helper>' models <<'JSON'
{}
JSON
\`\`\`

- \`profiles\` returns \`id\`, \`name\`, \`notes\`, \`provider\`, \`model\`, \`modeId\` and \`thinkingOptionId\` for each profile.
- The user configured these profiles for specific kinds of work. Read the notes.
- \`models\` returns the available providers and model IDs.

### 4. Split the goal into tasks

Size first:

1. Do not split one coherent change, a single-file change, or work that depends heavily on shared context. Define one task, or do a small edit yourself.
2. Scale the task count to the work. A fact lookup is 1 task. A comparison or a change across two layers is 2–4 tasks. Broad independent work is 5–8 tasks. The maximum is 12.

Then build the graph:

1. Split by file ownership or layer, not by step. Code and its tests are one task.
2. Put shared contracts, such as schemas, types and RPC shapes, in one early task. The other tasks depend on it.
3. Give each writable path to one task. Tasks that run at the same time must not write the same path.
4. Always set \`writes\`. Use \`[]\` for research and review. An omitted \`writes\` defaults to \`["."]\`, and that task then runs alone.
5. Put exclusive non-file items in \`resources\`, such as a lockfile install, a port, a database or a plugin reload.
6. Add \`dependsOn\` only for a real data flow or write order.
7. Add a read-only planning task when the design is open or 3 or more writers share a contract.
8. Add a read-only review task after risky writers. Set its \`reads\` to their \`writes\`.
9. Add an integration task when 2 or more writers change adjacent layers. It owns the glue files and runs the full checks.

Fields:

- \`id\`: letters, digits, \`_\` and \`-\`. It starts with a letter or digit, has 64 characters or fewer, and is unique.
- \`description\`: 4000 characters or fewer. A worker sees only the goal, its own task and the reports of its prerequisites. It does not see this conversation. Write each description as a standalone contract, in the format below.
- \`dependsOn\`: the task IDs that must complete first. Do not create cycles. Each dependent worker receives its prerequisites' reports.
- \`reads\` and \`writes\`: real checkout-relative paths, such as \`server\` or \`client/concerts/task-card.tsx\`. Do not use \`..\`, wildcards or symbolic links. \`writes: []\` makes a read-only task.
- \`resources\`: names for exclusive non-file items, such as \`npm-install\` or \`port-8080\`. Names use the \`id\` format. Tasks that share a resource run one at a time.
- \`checks\`: the exact commands or checks the worker must run and report, such as \`npm run check\`.

Description contract:

\`\`\`text
Objective: one sentence.
Context: decisions, constraints and user preferences from this conversation. Key files as path:line.
Inputs: prerequisite task IDs and what to take from each report.
Owned paths: same as writes. Do not touch: paths other tasks own.
Acceptance: testable criteria.
Out of scope: explicit exclusions.
Report: the evidence to return. Put the most important result first, because dependents receive a shortened report.
\`\`\`

Scheduling:

- Read-only tasks run at the same time.
- Writers in the same checkout run one at a time. Keep write scopes narrow.

### 5. Choose a worker for each task

Split first, then route. Do not create tasks to match profiles. Use the first option that fits:

1. A profile the user named for this task or role.
2. A configured profile whose \`notes\` fit the task role. Set \`profile\` to its \`id\`.
3. An inline \`provider\`, \`model\` and optional \`thinkingOptionId\` from \`models\`.
4. No worker fields. The worker inherits this session's provider, model, thinking setting and permission mode.

Do not set \`profile\` together with \`provider\`, \`model\` or \`thinkingOptionId\`.

| Role | Prefer |
|---|---|
| Implementation | The strongest coding profile for that layer. |
| Exploration or research | A fast or low-cost profile. |
| Planning or design | A profile with a high thinking option. |
| Review | A different provider or model than the implementer. |

Permissions: a worker never gets a broader permission mode than this session. A profile's \`modeId\` applies to its worker. Conductor rejects an elevated mode when this session is not elevated. A worker on a different provider without a \`modeId\` starts in that provider's default mode.

Fallback: if a worker choice fails with \`Unknown worker profile\`, \`Ambiguous worker profile\` or an elevated-mode error, use the next option in the list. State each fallback in the finish summary.

### 6. Define the tasks

\`\`\`bash
node '<helper>' define <<'JSON'
{"concertId":"<concertId>","tasks":[
  {"id":"schema","title":"Add inline worker fields","description":"Add provider, model and thinkingOptionId to the task schema. Acceptance: stored concerts without the fields still parse.","dependsOn":[],"reads":["shared"],"writes":["shared/concerts/commands.ts","shared/concerts/models.ts"],"checks":["npm run typecheck"]},
  {"id":"review","title":"Review the schema change","description":"Review the schema task for compatibility bugs. Report findings only.","dependsOn":["schema"],"reads":["shared/concerts/commands.ts","shared/concerts/models.ts"],"writes":[],"checks":[],"profile":"<profile id from profiles>"}
]}
JSON
\`\`\`

\`define\` runs once per concert. A second \`define\` with a different graph fails with \`This concert already has a different task graph.\`

### 7. Dispatch the tasks and wait

\`\`\`bash
node '<helper>' dispatch <<'JSON'
{"concertId":"<concertId>"}
JSON
\`\`\`

- Dispatch creates the worker agents and follows the dependencies.
- End your turn after dispatch. Worker reports arrive as messages in this conversation.
- Do not edit this checkout while workers run. Route changes through tasks.
- Do not poll in a loop. Run \`get\` with \`{"concertId":"<concertId>"}\` only when you need the current state.

### 8. Handle blocked and failed tasks

- Blocked: read the blocker. Resolve it, or ask the user. Then run \`dispatch\` with \`{"concertId","retryTaskId"}\` to resume the same worker.
- Failed: read the report and fix the cause. Then run \`dispatch\` with \`{"concertId","retryTaskId"}\`. You can add a replacement \`profile\`, or a replacement \`provider\`/\`model\`/\`thinkingOptionId\`.
- Do not replace a worker that is still active. The command fails with \`The task agent is still active.\`

### 9. Finish the concert

1. Wait until every task has explicitly reported and stopped. Do not infer completion from idle.
2. Read every report and its check results.
3. Verify the integrated result if the plan asks for it.
4. Run \`finish\` with \`{"concertId","summary"}\`. The summary states what changed, which checks passed or failed, and what remains.

## Troubleshooting

| Message | Cause | Action |
|---|---|---|
| Empty output | The command did not run. | Check the helper path and the stdin JSON. Retry with the same \`key\`. |
| \`Command input must be valid JSON.\` | The stdin JSON is malformed. | Fix the JSON. |
| \`Only this concert's Conductor agent can define or dispatch its tasks.\` | The \`concertId\` belongs to another agent. | Use the \`concertId\` from your own \`orchestrate\`. |
| \`This concert is not ready to dispatch.\` | \`define\` did not run, or the concert finished. | Run \`define\` first. |
| \`Unknown worker profile: <name>\` | No configured profile has that id or name. | Run \`profiles\`, or use an inline choice. |
| \`Ambiguous worker profile: <name>\` | Two profiles share the name. | Use the profile \`id\`. |
| \`Worker model is unavailable: <provider>/<model>\` | \`models\` does not list that model. | Run \`models\` and choose a listed ID. |
| \`Worker profile requests elevated permission mode: <mode>\` | The profile asks for more access than this session has. | Choose another profile, or an inline choice. |
| \`Task scope leaves the selected checkout.\` | A \`reads\` or \`writes\` path is outside the checkout. | Use checkout-relative paths. |

## Rules

- Do not commit or push unless the user authorized it.
- Do not expand the authorized scope.
- Do not start a second concert for the same request. Reuse the \`key\`.
- A task worker must not use this skill. A worker reports on its own attempt only.
`;
