// Embedded so Git and npm installs need no extra files or dev dependencies.
export const ORCHESTRATE_SKILL = `---
name: conductor-orchestrate
description: Turn an approved plan or request into a Paseo Conductor concert from this session. Split it into tasks, choose a worker provider and model per task (implement, explore, plan, review), dispatch worker agents, track their reports, and finish with a summary. Use when the user says "orchestrate", "conductor", "concert", "split this into tasks", "dispatch agents", "run this plan with agents", or asks to parallelize work across agents. Requires the Paseo Conductor plugin. Do not use it to create a dedicated orchestrator agent.
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

### 3. Split the goal into tasks

Rules:

- Define 1–12 tasks. Use 2 or more for multi-part work. Add a final integration or review task where needed.
- \`id\`: letters, digits, \`_\` and \`-\`. It starts with a letter or digit, has 64 characters or fewer, and is unique.
- \`description\`: the assignment and its acceptance criteria. A worker sees only the goal, its own task and the reports of its prerequisites. It does not see this conversation. Write each description so it stands alone.
- \`dependsOn\`: the task IDs that must complete first. Do not create cycles. Each dependent worker receives its prerequisites' reports.
- \`reads\` and \`writes\`: real checkout-relative paths, such as \`server\` or \`client/run-task-card.tsx\`. Do not use \`..\`, wildcards or symbolic links. \`writes: []\` makes a read-only task.
- \`checks\`: the exact commands or checks the worker must run and report, such as \`npm run check\`.

Scheduling:

- Read-only tasks run at the same time.
- Writers in the same checkout run one at a time. Keep write scopes narrow.

Task size:

- Give one worker one coherent change that fits in one focused session.
- Split by file ownership or layer, not by step. Code and tests for the same files are one task.
- Put shared contracts, such as schemas and types, in an early task that the others depend on.

### 4. Choose a worker for each task

Default: omit the worker fields. The worker inherits this session's provider, model, thinking setting and permission mode.

To choose a worker, list the options first:

\`\`\`bash
node '<helper>' profiles <<'JSON'
{}
JSON
node '<helper>' models <<'JSON'
{}
JSON
\`\`\`

Then set one of these:

- \`profile\`: a configured profile name. Use the profile notes to choose.
- \`provider\`, \`model\` and optional \`thinkingOptionId\`: an inline choice from \`models\`.

Do not set both.

| Role | \`writes\` | Worker choice |
|---|---|---|
| Implementation | A narrow scope | A strong coding model. The default is usually correct. |
| Exploration or research | \`[]\` | A faster or cheaper model is enough. |
| Planning or design | \`[]\` | A high-reasoning model or thinking option. |
| Review | \`[]\` | A different provider or model than the implementer, for an independent view. |

Permissions: a worker never gets a broader permission mode than this session. A worker on a different provider starts in that provider's default mode.

### 5. Define the tasks

\`\`\`bash
node '<helper>' define <<'JSON'
{"concertId":"<concertId>","tasks":[
  {"id":"schema","title":"Add inline worker fields","description":"Add provider, model and thinkingOptionId to the task schema. Acceptance: stored runs without the fields still parse.","dependsOn":[],"reads":["shared"],"writes":["shared/run-commands.ts","shared/run-models.ts"],"checks":["npm run typecheck"]},
  {"id":"review","title":"Review the schema change","description":"Review the schema task for compatibility bugs. Report findings only.","dependsOn":["schema"],"reads":["."],"writes":[],"checks":[],"provider":"codex","model":"<model ID from models>"}
]}
JSON
\`\`\`

\`define\` runs once per concert. A second \`define\` with a different graph fails with \`This concert already has a different task graph.\`

### 6. Dispatch the tasks and wait

\`\`\`bash
node '<helper>' dispatch <<'JSON'
{"concertId":"<concertId>"}
JSON
\`\`\`

- Dispatch creates the worker agents and follows the dependencies.
- End your turn after dispatch. Worker reports arrive as messages in this conversation.
- Do not edit this checkout while workers run. Route changes through tasks.
- Do not poll in a loop. Run \`get\` with \`{"concertId":"<concertId>"}\` only when you need the current state.

### 7. Handle blocked and failed tasks

- Blocked: read the blocker. Resolve it, or ask the user. Then run \`dispatch\` with \`{"concertId","retryTaskId"}\` to resume the same worker.
- Failed: read the report and fix the cause. Then run \`dispatch\` with \`{"concertId","retryTaskId"}\`. You can add a replacement \`profile\`, or a replacement \`provider\`/\`model\`/\`thinkingOptionId\`.
- Do not replace a worker that is still active. The command fails with \`The task agent is still active.\`

### 8. Finish the concert

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
| \`Unknown worker profile: <name>\` | No configured profile has that name. | Run \`profiles\`, or use an inline choice. |
| \`Worker model is unavailable: <provider>/<model>\` | \`models\` does not list that model. | Run \`models\` and choose a listed ID. |
| \`Worker profile requests elevated permission mode: <mode>\` | The profile asks for more access than this session has. | Choose another profile, or an inline choice. |
| \`Task scope leaves the selected checkout.\` | A \`reads\` or \`writes\` path is outside the checkout. | Use checkout-relative paths. |

## Rules

- Do not commit or push unless the user authorized it.
- Do not expand the authorized scope.
- Do not start a second concert for the same request. Reuse the \`key\`.
- A task worker must not use this skill. A worker reports on its own attempt only.
`;
