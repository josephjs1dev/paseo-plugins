// Embedded so Git and npm installs need no extra files or dev dependencies.
export const ORCHESTRATE_SKILL = `---
name: conductor-orchestrate
description: Turn an approved plan or request into a Paseo Conductor symphony from this session. Split it into tasks, choose a configured profile or model per task (implement, explore, plan, review), dispatch task agents, track their reports, and finish with a summary. Use when the user says "orchestrate", "conductor", "symphony", "split this into tasks", "dispatch agents", "run this plan with agents", or asks to parallelize work across agents. Requires the Paseo Conductor plugin. Do not use it to create a dedicated Conductor agent.
---

# Conductor orchestrate

This session is the Conductor. You plan, dispatch, review and finish. Task agents do the task work. Do not create a dedicated Conductor agent.

## Terms

| Term | Meaning |
|---|---|
| Symphony | One task orchestration: this Conductor session plus its task agents, as shown in the Podium. |
| \`symphonyId\` | The symphony ID: a UUID that \`orchestrate\` returns. |
| Task | One bounded assignment for one task agent. |
| Attempt | One task agent's try at a task. A retry of a failed task or a reopened task creates a new attempt. |
| Loop | One pass over the score, numbered from 1. A loop ends when nothing runs and nothing more can start. It *succeeded* when every task's latest attempt is \`completed\`; otherwise it *needs changes*. Fixes run in the next loop of the same symphony. |
| Outcome | A report's result. \`completed\`: done, every check passed, no blocking findings. \`needs-changes\`: the work ran, but checks still fail or a review found blocking findings; the next loop resolves it. \`failed\`: the harness could not run the work (launch, unreachable agent, permissions, sandbox, refused scope, unavailable model); retried in the same loop. |
| Finding | A defect in a report: \`{id, severity: blocking or minor, taskId, paths, summary, suggestedFix}\`. \`loop\`, \`deferred\` and \`unresolved\` name it as \`<reporter task>#<id>\`, such as \`review#F1\`. |
| Task agent | A child agent that the Conductor creates for a task. Commands and profiles call this role \`worker\`. |

## Use the Conductor tools

1. Conductor commands are MCP tools on the \`conductor\` server named in the \`[Conductor agent commands]\` system instructions, such as \`orchestrate\`, \`define\` and \`dispatch\`. The provider may add a prefix, such as \`mcp__conductor__orchestrate\`. Paseo binds this agent's identity to the server.
2. Call the tools directly with their arguments. Never run Conductor commands or the MCP server through a shell.
3. If the tools are missing, stop. Tell the user to enable the Conductor plugin in Paseo and start a new agent.

Example \`orchestrate\` arguments:

\`\`\`json
{"key":"task-priority","title":"Add task priority","goal":"..."}
\`\`\`

Every successful call returns an acknowledgement. An error result is a failure. Each tool's description and input schema give its fields.

## Workflow

### 1. Confirm the goal

- Use the approved plan from this conversation, or the user's request.
- Ask only if the scope or the authorized actions are unclear.
- Do not orchestrate a small edit. Do it yourself, unless the user asks for a symphony.

### 2. Start the symphony

\`orchestrate\` input:

- \`key\`: a stable request key, such as \`task-priority\`. Reuse the same key after an empty or uncertain response. A repeated key returns the same symphony, not a second one.
- \`title\`: 160 characters or fewer.
- \`goal\`: 16000 characters or fewer. Include the plan, the constraints and the acceptance criteria.
- \`concurrency\`: optional, 1–4, default 3.
- \`maxLoops\`: optional loop budget, 1–5, default 3. Past it, \`loop\` needs the user's approval.
- Do not set \`conductor\` or \`conductorProfile\`.

Keep the returned \`symphonyId\`. Read the returned \`instructions\`. If they differ from this skill, follow the instructions.

### 3. List profiles and models

Call \`profiles\` and \`models\` before you split the goal. Neither takes arguments.

- \`profiles\` returns Conductor-owned profile identity, notes, provider/model/permission fields, routing classification, \`hasInstructions\`, one catalog revision and diagnostics. It does not return instruction text. A profile is classified only when it has at least one role and a size; never guess a size from a model name.
- Create and edit profiles in Podium › Profiles. Choose a provider/model and configure roles and size there. Add skill names the task agent should use to the profile's instructions; Conductor does not discover skills.
- \`profiles.providers\` supplies the provider/model/thinking-option/mode catalog used by the Podium pickers. \`models\` lists available providers and model IDs for worker selection. Podium › Profiles also offers a one-time import from Paseo profiles; imported entries become independent Conductor profiles.
- \`route\` is read-only. Pass a \`role\` and optionally an explicit profile or inline worker choice. It returns the selected profile, eligible alternatives ordered by size (small, medium, large), exclusions and concise reasons. Subject-matter fit comes from profile notes, not model-name heuristics.
- Profile data is stored by Conductor under \`<PASEO_HOME>/plugin-data/conductor/profiles.json\`; edit it through Podium › Profiles. A missing store means no profiles are configured and mode is \`warn\`.

### 4. Split the goal into tasks

Size first:

1. Do not split one coherent change, a single-file change, or work that depends heavily on shared context. Define one task, or do a small edit yourself.
2. Scale the task count to the work. A fact lookup is 1 task. A comparison or a change across two layers is 2–4 tasks. Broad independent work is 5–8 tasks. The maximum is 12.

Then build the score:

1. Split by file ownership or layer, not by step. Code and its tests are one task.
2. Put shared contracts, such as schemas, types and RPC shapes, in one early task. The other tasks depend on it.
3. Give each writable path to one task. Tasks that run at the same time must not write the same path.
4. Always set \`writes\`. Use \`[]\` for research and review. An omitted \`writes\` defaults to \`["."]\`, and that task then runs alone.
5. Put exclusive non-file items in \`resources\`, such as a lockfile install, a port, a database or a plugin reload.
6. Add \`dependsOn\` only for a real data flow or write order.
7. Add a planning task only to resolve a named open design decision. Writer count or a shared contract alone never calls for a planning task. Executing an approved design is implementation.
8. End a writing score with a read-only review task: set \`review: true\`, \`writes: []\`, and its \`reads\` to the writers' \`writes\`. A review task starts once each prerequisite is \`completed\` or \`needs-changes\`, and receives their open findings and failed checks, so one loop collects every defect. Other tasks wait for \`completed\` prerequisites.
9. Add an integration task when 2 or more writers change adjacent layers. It owns the glue files and runs the full checks.

Fields:

- \`id\`: letters, digits, \`_\` and \`-\`. It starts with a letter or digit, has 64 characters or fewer, and is unique.
- \`description\`: 4000 characters or fewer. A task agent sees only the goal, its own task and the reports of its prerequisites. It does not see this conversation. Write each description as a standalone contract, in the format below.
- \`dependsOn\`: the task IDs that must complete first. Do not create cycles. Each dependent task agent receives its prerequisites' reports.
- \`reads\` and \`writes\`: real checkout-relative paths, such as \`server\` or \`client/symphonies/task-card.tsx\`. Do not use \`..\`, wildcards or symbolic links. \`writes: []\` makes a read-only task.
- \`resources\`: names for exclusive non-file items, such as \`npm-install\` or \`port-8080\`. Names use the \`id\` format. Tasks that share a resource run one at a time.
- \`checks\`: the exact commands or checks the task agent must run and report, such as \`npm run check\`.
- \`review\`: \`true\` for a read-only review task. Only a review task may report findings against other tasks.
- \`role\`: optional routing intent: \`exploration\`, \`implementation\`, \`planning\` or \`review\`.
- \`openDecision\`: name the unresolved decision for a \`planning\` task. \`role: "planning"\` requires it; use \`implementation\` to carry out an approved decision. A \`review\` role requires \`review: true\`.

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

### 5. Choose a task agent for each task

Split first, then route. Do not create tasks to match profiles.

1. Honor a profile the user named, subject to availability and the permission ceiling.
2. Otherwise run \`route\` with the task role. Match subject matter from each profile's “When to use” notes. Pick the smallest eligible profile for the role (small, then medium, then large); ties follow store order, then profile ID. Do this even when the deliverable is prose or Markdown. Use \`implementation\` to execute an approved design; use \`planning\` only for open design decisions. Prefer a reviewer on a different provider/model from the implementer.
3. Give each task focused context and a short visible selection reason in \`routing: {"reason":"..."}\`; an automatic route supplies its own concise reason. Automatic routing ignores “When to use” notes: it takes the smallest size, then store order. Omit worker fields only when exactly one eligible profile has the smallest size for the role. When two or more share the smallest size, name one with \`profile\`, chosen by its “When to use” notes, and give the reason. If none is eligible, choose an explicit profile, an inline \`provider\`/\`model\` (optional \`thinkingOptionId\`), or \`profile: "inherit"\` with a reason. Inherit is explicit opt-in; never silently inherit the Conductor's model.
4. Escalate past the eligible smaller-first choice only for an explicit user choice, a concrete capability gap, an observed model limitation after bounded corrective attempts, or no eligible configured profile. Add \`routing.override: {"category":"user-choice|capability-gap|observed-limitation|no-eligible-profile","evidence":"specific evidence"}\`. When no profile is eligible, choose an explicit profile, inline worker, or \`profile: "inherit"\` with a reason; strict mode also requires a valid \`no-eligible-profile\` override. “Needs quality” is not evidence. Diagnose missing input, permissions and sandbox issues before treating failure as a model limitation.

| Role | Routing |
|---|---|
| Implementation | Smallest eligible implementation profile whose “When to use” notes fit the subject, including writing work. |
| Exploration | Smallest eligible exploration profile whose “When to use” notes fit the subject. |
| Planning | Use only while design decisions remain open. |
| Review | Prefer a different provider/model than the implementer, while matching role and subject in the notes. |

Profiles are owned by Conductor and edited in Podium › Profiles. Set the routing mode there with the **Enforce routing** switch: off is \`warn\` (the default), and on is \`strict\`. Each profile has routing fields (\`roles\` and \`size\`: \`small\`, \`medium\` or \`large\`), “When to use” notes, and free-text instructions. The notes guide subject-matter matching. A profile without roles or size is unclassified and shows a warning in its Profiles card; routing cannot select it. Instructions are delivered to the task agent in a clearly marked section; they cannot override user instructions, repository rules, write scope, or the permission ceiling. Put skill names the agent should use in these instructions. The Conductor filters by classification, role, provider availability and permission ceiling, then prefers the smallest eligible size. \`warn\` is the default: a larger-than-eligible, ineligible, unclassified or inline choice is accepted with a warning in the acknowledgement and attempt. \`strict\` requires a valid override category and specific evidence. Unknown/stale profile IDs appear in diagnostics.

Permissions: a task agent never gets a broader permission mode than this session. An explicit profile \`modeId\` overrides the inherited Conductor mode; a task agent on another provider without a profile mode starts in that provider's default mode. Conductor rejects an elevated mode when this session is not elevated. \`define\`, \`loop\` and \`dispatch\` validate choices; dispatch revalidates if the catalog revision changes.


### 6. Define the tasks

\`define\` arguments:

\`\`\`json
{"symphonyId":"<symphonyId>","tasks":[
  {"id":"schema","title":"Add a task priority field","description":"Add an optional priority from 1 to 3 to the task schema. Acceptance: define accepts priorities 1–3 and rejects other values.","dependsOn":[],"reads":["shared"],"writes":["shared/symphonies/commands.ts","shared/symphonies/models.ts"],"checks":["npm run typecheck"]},
  {"id":"review","title":"Review the schema change","description":"Review the schema task for validation gaps and missing tests. Report each blocking defect as a finding with taskId schema and path:line.","dependsOn":["schema"],"reads":["shared/symphonies/commands.ts","shared/symphonies/models.ts"],"writes":[],"checks":[],"review":true,"profile":"<profile id from profiles>"}
]}
\`\`\`

\`define\` runs once per symphony. A second \`define\` with a different score fails with \`This symphony already has a different score.\` Add tasks in a later loop with \`loop\` \`tasks\` (step 8b).

### 7. Dispatch the tasks and wait

\`dispatch\` arguments:

\`\`\`json
{"symphonyId":"<symphonyId>"}
\`\`\`

- Dispatch creates the task agents and follows the dependencies.
- End your turn after dispatch. Task agent reports arrive as messages in this conversation.
- Do not edit this checkout while task agents run. Route changes through tasks.
- Do not poll in a loop. Call \`get\` with \`{"symphonyId":"<symphonyId>"}\` only when you need the current state.

### 8. Handle blocked and failed tasks

This step covers only \`failed\` (a harness problem) and \`blocked\` tasks. A \`needs-changes\` task is not retried; it is resolved by the next loop (step 8b).

- Act on the per-task notification summary first. Call \`get\` or open a task agent's conversation only when the summary does not explain the failure. Task agents diagnose and fix their own changes for up to 3 rounds; do not fix the cause yourself.
- Choose the retry action from \`diagnosis.need\`. For \`scope\`, dispatch with \`retryTaskId\` and \`addWrites\` set to \`requestedWrites\`, or ask the user if those paths exceed the goal. For \`input\`, ask the user, then include the answer in \`note\`. For \`model\`, choose a different \`profile\` or \`provider\`/\`model\`/\`thinkingOptionId\`. For \`harness\` (or the older \`none\`), include a specific direction in \`note\`.
- A failed task gets at most 2 retries per loop (3 attempts), counted only from \`failed\` attempts in that loop. Blocker resumes and nudges do not count, and failed retries never use the loop budget. A task agent that stops without reporting after the nudge, becomes unreachable, or whose launch stays unconfirmed is \`failed\` with \`need: "harness"\`; retrying an unconfirmed launch replays the same agent identity and counts. At the limit, \`dispatch\` refuses the retry; ask the user how to proceed.
- Retry on the same worker choice first. A harness failure does not justify switching models: diagnose missing input, permissions and sandbox first. Escalate only for a concrete capability gap or observed model limitation, with a specific routing override. Never
  switch to a profile whose \`modeId\` is broader than this session's. If every
  available choice has failed, ask the user.
  Otherwise dispatch with \`retryTaskId\`; include \`note\` when giving guidance.
  An unchanged worker choice continues on the same agent when it still exists
  and is inactive; otherwise Conductor creates a new agent. A blocked task
  resumes on its task agent when the worker choice is unchanged and it can
  receive a message; a changed worker choice starts a new agent. Do not replace
  an active task agent.
- Task agents can request extra write paths with \`widen\`. A refusal leaves scope unchanged; use \`need: "scope"\` and \`requestedWrites\` so you can retry with \`addWrites\` or ask the user.

### 8b. Loops

A loop ends when nothing runs and nothing more can start. Its wake states the verdict once per loop. Resolve \`failed\` and \`blocked\` tasks with step 8 first; \`loop\` is refused while any remain.

- *Succeeded*: go to step 9.
- *Needs changes*: the wake lists the blocking findings and failed checks with their owning tasks. Do not fix them yourself, and never start a new symphony for them.
  1. Group the findings by owning task: the finding's \`taskId\`, or the reporting task when it has none.
  2. Send \`loop\` with \`reopen\` for each owning task and its findings. Each reopened task continues on its existing agent when that agent can receive a message; otherwise a new agent starts with the previous report. Use \`note\` for direction, \`addWrites\` for missing scope, and \`after\` for loop-only prerequisites. Change workers after a check/review failure only through the reopen worker override (\`profile\` or inline \`provider\`/\`model\`/\`thinkingOptionId\`) with \`routing.reason\` and any required evidence-backed \`routing.override\`.
  3. Add a planning task through \`tasks\` only when the fix needs a design decision, and put it in the reopened task's \`after\`.
  4. Defer a finding or task in \`deferred\` only with a concrete reason. Every blocking finding and every \`needs-changes\` task must be reopened or deferred. A deferred item stays open: later wakes list it again, and every later \`loop\` must reopen or defer it again. Name a finding as \`<reporter task>#<id>\` when two reports use the same id.
  5. End your turn. Transitive dependents of reopened tasks, including the review, re-run automatically in the new loop; the review receives the previous findings and confirms each fix.
- *Repeated findings*: when the wake says the findings repeat the previous loop, ask the user before you start another loop.
- *Budget used*: when the wake says the loop budget is used, ask the user whether to continue or stop. Send \`loop\` with \`approval: {"loops": <next loop number>, "userAnswer": "<the user's words>"}\` only after the user answered in this conversation. If the user chooses to stop, finish with \`unresolved\` (step 9).

\`loop\` arguments:

\`\`\`json
{"symphonyId":"<symphonyId>","reason":"Fix review findings F1-F3",
 "reopen":[
  {"taskId":"api","findings":["review#F1","review#F2"],"note":"Validate concertId before lookup.","after":["plan-2"]},
  {"taskId":"ui","findings":["review#F3"]}],
 "tasks":[{"id":"plan-2","title":"Plan the concertId validation","description":"...","dependsOn":[],"reads":["server","shared"],"writes":[],"checks":[]}],
 "deferred":[{"finding":"review#F4","reason":"Needs a user decision on the API shape"}]}
\`\`\`

### 9. Finish the symphony

1. Wait until every task has explicitly reported and stopped. Do not infer completion from idle.
2. Read every report and its check results.
3. Review every attempt's \`addedWrites\` (paths the Conductor added) and \`grantedWrites\` (paths a task agent widened to), with their reasons. List those paths and reasons in the finish summary.
4. Verify the integrated result if the plan asks for it.
5. Call \`finish\` with \`{"symphonyId","summary"}\` after a loop succeeded. The summary states what changed, which checks passed or failed, the number of loops, minor findings, deferred items with their reasons, what remains, and any granted paths with their reasons.
6. Only when the user chose to stop with open work, wait until every task agent has stopped and settled, then add \`unresolved: [{"finding" or "taskId", "reason"}]\` covering every open blocking finding and every task without a completed report. The symphony then ends as failed; list each unresolved item in the summary.

## Troubleshooting

| Message | Cause | Action |
|---|---|---|
| No Conductor tools | The Conductor MCP server did not start for this agent. | Tell the user to enable the Conductor plugin and start a new agent. |
| \`Command acknowledgement is uncertain.\` | The daemon did not confirm the command in time. | Call \`get\` to inspect, then retry with the same \`key\` or attempt. |
| \`Invalid command fields. Check the tool's input schema.\` | The arguments do not match the tool schema. | Fix the arguments. |
| \`Only this symphony's Conductor agent can define or dispatch its tasks.\` | The \`symphonyId\` belongs to another agent. | Use the \`symphonyId\` from your own \`orchestrate\`. |
| \`This symphony is not ready to dispatch.\` | \`define\` did not run, or the symphony finished. | Call \`define\` first. |
| \`Unknown worker profile: <name>\` | No configured profile has that id or name. | Call \`profiles\`, or use an inline choice. |
| \`Ambiguous worker profile: <name>\` | Two profiles share the name. | Use the profile \`id\`. |
| \`Task agent model is unavailable: <provider>/<model>\` | \`models\` does not list that model. | Call \`models\` and choose a listed ID. |
| \`Worker profile requests elevated permission mode: <mode>\` | The profile asks for more access than this session has. | Choose another profile, or an inline choice. |
| \`Task "<id>" routing: ... Add routing.override {category, evidence} or choose an eligible profile.\` | Strict routing rejected a larger, ineligible, unclassified, inline or inherited choice. | Call \`route\`; choose the first eligible profile or provide a valid override category and specific evidence. |
| \`Task "<id>" needs routing.reason for its worker choice.\` | A task or reopen worker choice has no visible selection reason. | Add \`routing: {"reason":"..."}\`; reopen overrides require it. |
| \`Task "<id>" override evidence is generic; name the concrete capability gap, observed failure or user statement.\` | Override evidence is vague or only says quality/complexity. | State the specific user choice, capability gap or observed limitation. |
| \`Task "<id>" has no eligible configured profile. Set an explicit profile, provider/model, or profile "inherit" with routing.reason.\` | No eligible profile exists for automatic routing. | Choose an available worker explicitly, or use \`profile: "inherit"\` with a reason; strict mode also requires a specific \`no-eligible-profile\` override. |
| \`Profile catalog changed since define (...); routing was revalidated.\` | Routing fields changed after definition; dispatch revalidated the choices. | Review \`profiles\` and \`route\`; reopen with a validated worker override if needed. |
| \`Conductor profiles are invalid: ... Fix them in Podium › Profiles.\` | The profile store is unreadable or invalid. | Open Podium › Profiles, correct the reported profile data, and retry. |
| \`Conductor could not load or save the worker profiles. Refresh and check conductor storage.\` | The profiles RPC could not read or persist the store. | Refresh Podium and check Conductor storage. |
| \`\`Retry requires a settled failed or blocked task agent; a needs-changes task is resolved with \`loop\`, not a retry.\`\` | The task reported \`needs-changes\`, or its agent has not settled. | Wait for the loop to end, then reopen the task with \`loop\` (step 8b). |
| \`Retry refused: task "<id>" already used its 2 failed retries in loop <N>. Ask the user how to proceed.\` | The task reached the failed-retry limit for this loop. | Ask the user. Do not start a new symphony. |
| \`A loop starts only after the current loop ends needing changes with no failed, blocked or running tasks.\` | Tasks still run or can start, a task is \`failed\` or \`blocked\`, or the loop succeeded. | Wait for the loop-end wake, resolve failed and blocked tasks with step 8, or finish a succeeded loop. |
| \`Loop must reopen or defer every open item: ...\` | A blocking finding or \`needs-changes\` task is in neither \`reopen\` nor \`deferred\`. | Reopen each owning task, or defer the listed items with a reason. |
| \`Loop <N> exceeds the loop budget (<max>). Ask the user, then resend with approval {loops, userAnswer}.\` | The next loop is past \`maxLoops\`. | Ask the user. Resend with \`approval\` only with the user's answer, or finish with \`unresolved\`. |
| \`Unknown finding "<ref>" for task "<id>".\` | \`findings\` names a finding the previous loop did not report. | Use \`<reporter task>#<finding id>\` from the wake or \`get\`. |
| \`\`Finish requires a completed report for every task and settled task agents, or an \`unresolved\` list covering everything still open.\`\` | A task's latest attempt is not \`completed\`, or an agent has not settled. | Start the next loop, or ask the user and finish with \`unresolved\`. |
| \`Finish with unresolved must cover every open finding and non-completed task: ...\` | \`unresolved\` misses an open item. | Add each listed finding or task with a reason. |
| \`Task scope leaves the selected checkout.\` | A \`reads\` or \`writes\` path is outside the checkout. | Use checkout-relative paths. |
| A blocked retry with a new worker choice succeeds | The changed choice starts a new agent on the attempt. | Check the dispatch acknowledgement for the new agent ID. |
| \`Widen refused: this attempt has used its 2 widen calls.\` | The attempt reached its widen-call limit. | Report \`need: "scope"\` and \`requestedWrites\`; retry with \`addWrites\` or ask the user. |
| \`Widen refused: an attempt may hold at most 10 granted paths.\` | The request exceeds the attempt's total grant limit. | Report \`need: "scope"\` and request the necessary paths through \`addWrites\` or ask the user. |
| \`Widen refused: ...\` naming another task or reader | The requested paths overlap an unfinished task's writes or a resource-holding attempt. | Do not edit those paths. Report \`need: "scope"\` with \`requestedWrites\`; the Conductor can retry after the conflict clears or use \`addWrites\` when appropriate. |
| \`Only the assigned task agent can widen its attempt's write scope.\` / \`Only a running attempt can widen its write scope.\` | The caller is not the assigned task agent, or the attempt is no longer running. | Call \`widen\` from the assigned task agent while its attempt is running; otherwise report the scope need to the Conductor. |

## Rules

- Do not commit or push unless the user authorized it.
- Do not expand the authorized scope.
- Do not start a second symphony for the same request. Reuse the \`key\`.
- Fixes for review findings always stay in the same symphony: use \`loop\`. Never start a symphony to fix another symphony's findings.
- Never \`finish\` while a review has open blocking findings, except with \`unresolved\` after the user chose to stop.
- Never send \`approval\` unless the user answered in this conversation.
- A task agent must not use this skill. A task agent reports on its own attempt only.
`;
