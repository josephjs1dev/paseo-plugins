# Conductor

Conductor adds a Paseo podium for finding blockers, responding to agents, and
following work across projects and concerts on the selected daemon.

## Vocabulary

Conductor uses musical terms for the orchestration structure and roles, and
technical names for units of work.

| Technical term      | Conductor term | Meaning                                                         |
| ------------------- | -------------- | --------------------------------------------------------------- |
| Paseo workspace     | Concert        | One project that can contain several symphonies                 |
| Inbox / overview    | Podium         | The screen that follows agents and symphonies                   |
| Task orchestration  | Symphony       | One orchestrated goal, from score to finish                     |
| Orchestrating agent | Conductor      | Writes the score, dispatches task agents, reviews, and finishes |
| Task graph          | Score          | A symphony's tasks and their dependencies                       |
| Task                | Task           | One unit of work in the score                                   |
| Worker agent        | Task agent     | The agent assigned to one task                                  |
| Attempt / retry     | Attempt        | One try at a task; numbered per task, and attempt 2+ is a retry |
| Iteration           | Loop           | One pass over the score; fixes run in the next loop             |
| Outcome             | Outcome        | A report's result: completed, needs changes, or failed          |

A report has one of three outcomes:

- **completed**: the work is done, every required check passed and, for a
  review, there are no blocking findings. Dependents start.
- **needs changes** (`needs-changes`): the work ran, but required checks still
  fail after the task agent's own fix rounds, or a review found blocking
  findings. The next loop resolves it; it is not retried within the loop.
- **failed**: the harness could not run the work: the launch failed or is
  unconfirmed, the agent is unreachable or stopped without reporting after the
  nudge, or it cannot edit, read, or run what the task needs. Retried within the
  same loop.

A **loop** is one pass over the score, numbered from 1. It ends when no attempt
is running and nothing more can start. It _succeeded_ when every task's latest
attempt is completed; otherwise it _needs changes_, and the Conductor starts the
next loop in the same symphony.

A symphony is split into tasks; do not call tasks pieces or parts. A concert
has symphonies. Use _workspace_ only when describing Paseo itself.

Install the Conductor skills once: open the Command Center (**⌘K** on macOS,
**Ctrl+K** elsewhere) and select **Install conductor skills**. It writes each skill,
currently `conductor-orchestrate/SKILL.md`, to `~/.claude/skills` and
`~/.agents/skills` on the daemon host. Run it again after a plugin update;
**Remove conductor skills** deletes only copies that Conductor installed and never overwrites a skill of the
same name that you created.

Then invoke `conductor-orchestrate` in any agent, or ask the agent to orchestrate.
That agent becomes the Conductor and keeps its conversation context: it splits the
work into tasks, chooses a task agent per task, and dispatches real child agents. The
Symphonies tab shows planning, task agents, dependencies, blockers, and reported
results.

## Features

### Symphonies

Each symphony is one task orchestration: a Conductor agent and its task agents.
Agent commands use `symphonyId` and acknowledge with `symphonyId`/`symphony`
(`symphonies` for `list`). UI RPCs use `symphonies.*`.

The user supplies the goal, not a task form. The Conductor agent defines the score
and chooses a task agent per task: a configured profile, an inline
provider/model, or the Conductor's own settings. Each ready task
gets its own child agent, with a link from its task, score node, and per-task attempt history.
**Conductor agent** opens the conducting conversation. Agents and Symphonies remain
separate sections of the same Podium and retain independent searches and selections.

The score draws directed dependencies and supports keyboard selection, agent
navigation, and scrolling on small screens. Symphonies uses the same underlined filters,
compact search, and list rows as Agents, and groups rows under project headings like
the Agents queue; a row omits the concert name when the concert shares the project's
name. Symphonies track executed work.

Up to four read-only task agents can run concurrently (three by default). Task agents share
the current checkout; writers are serialized, including against existing recorded
Symphonies. Scope declarations guide task assignment and prompts; they are not filesystem
sandboxes. Profiles preserve configured settings without silently granting broader
permissions. Small edits need no symphony unless requested.

A report alone does not release an orchestrated task agent's resources. Dependencies
wait for an explicit completed report with all required checks passed **and** an
observed end to the task agent's turn. A task agent that stops without reporting is
nudged once to report or block; a second stop, an unreachable agent, or a launch
that stays unconfirmed after backoff re-checks fails the attempt with a server
report and `need: "harness"`. `blocked` only means the task agent asked to
pause. The Conductor agent
acts on bounded per-task failure summaries, reviews all results, and finishes
the symphony with a summary.

New agents receive a local `conductor` MCP configuration with `report`,
`block`, `get`, and `widen` tools. Task agents prefer these tools for reporting,
checking an acknowledgement, recording a blocker, and requesting extra write
scope. The provider launches the stdio bridge outside shell command execution,
so Codex workers do not need shell sandbox escalation to report. It uses the
existing local command service; no TCP listener or extra npm runtime dependency
is added. Paseo's provider adapters handle MCP support, including detection at
runtime. Providers that do not expose the tools retain the command-line workflow.
The MCP tools cover task reporting and recovery. Orchestration commands such as
`orchestrate`, `define`, `dispatch`, and `finish`, and the source-only `start` and
`claim` workflow, still use the command-line helper and its shell permissions.

Each bridge uses an agent-bound launcher created before its interactive session
opens. Tool arguments cannot choose another agent identity or socket. The daemon
still checks task ownership, report contents and required checks, and accepts an
identical repeated report without replacing its evidence. MCP tool approval
policies still apply. Existing MCP servers and tool policies are preserved. If
`conductor` is already configured, the injected server uses the first available
name such as `conductor_2`, named in that agent's system instructions.

Reload the plugin to enable injection for newly created agents. Agents created
before this change keep their existing MCP configuration, including on refresh
or resume, and can continue using the command-line helper. An MCP error or an
ended turn alone never counts as an accepted task report.

Task agents diagnose and fix their own changes before reporting, with up to
3 fix rounds and an early stop for repeated errors, refused scope requests, or
needs for input or another model. Checks that still fail are reported as
`needs-changes` with the failing checks; `failed` reports carry a structured
diagnosis with `need` `scope`, `input`, `model`, or `harness` (stored `none`
reports remain readable). Reports may list up to 24 findings
(`{id, severity: blocking|minor, taskId?, paths, summary, suggestedFix?}`);
`needs-changes` needs a blocking finding or a failed check, `completed` allows
only minor findings, and only a review task may name another task in `taskId`. A task agent
can request up to 5 extra write paths per `widen` call and 2 calls per attempt;
the server refuses paths owned by unfinished tasks or overlapping resources
held by another attempt. Each grant records its reason on the attempt.

### Orchestration command flow

Agents start orchestration with:

```bash
node "$CONDUCTOR_COMMAND" orchestrate <<'JSON'
{"key":"feature-request-1","title":"Implement the feature","goal":"Inspect the repository, split the requested feature into tasks, implement and verify it","concurrency":3,"maxLoops":3}
JSON
```

By default the requesting agent becomes the symphony's Conductor agent. The
acknowledgement includes `instructions` for defining, dispatching, and finishing
the symphony from the same conversation; no separate Conductor agent is created. While task
agents work, the Conductor should not edit the checkout itself, because
Conductor only serializes writes between task agents. Notifications to a busy
Conductor wait until its turn ends.

Set `"conductor":"agent"` to create a dedicated Conductor agent instead. Optional
`conductorProfile` selects its configured profile by name and implies
`"conductor":"agent"`; otherwise it inherits the requesting agent's settings.
`profiles` returns Conductor-owned profile identity, notes, provider/model and
permission fields, routing classification, `hasInstructions`, one catalog
revision and diagnostics. It does not return instruction text. Unclassified
profiles are missing at least one role or a size; never infer size from a model name. Create
and edit profiles in Podium › Profiles. The provider/model pickers use the
`profiles.providers` catalog, which includes thinking options and modes. The
Profiles tab also offers a one-time import from Paseo profiles; imported entries
become independent Conductor profiles. Only the Conductor agent can define or
dispatch its symphony:

```bash
node "$CONDUCTOR_COMMAND" define <<'JSON'
{"symphonyId":"<symphony UUID>","tasks":[{"id":"api","title":"Inspect API","description":"Report API constraints with evidence","reads":["src/api"],"writes":[],"checks":[]},{"id":"ui","title":"Inspect UI","description":"Report UI constraints with evidence","reads":["src/ui"],"writes":[],"checks":[]},{"id":"combine","title":"Combine findings","description":"Compare API and UI reports","dependsOn":["api","ui"],"reads":[],"writes":[],"checks":[]}]}
JSON
node "$CONDUCTOR_COMMAND" dispatch <<'JSON'
{"symphonyId":"<symphony UUID>"}
JSON
```

Route each task with `route`, a read-only preview taking `role` (`exploration`,
`implementation`, `planning`, or `review`) and an optional explicit profile or
inline worker choice. It returns the selected profile, eligible alternatives
ordered by size, exclusions with the requirement each failed, and concise
reasons. The Conductor filters by classification, role, provider availability
and permission ceiling, then prefers the smallest eligible size (`small`,
`medium`, `large`), followed by store order and profile ID. Match subject
matter from the profile's “When to use” notes, even for prose or Markdown
output. Run implementation work for an approved design; use planning only
while design decisions remain open. Prefer a reviewer on a different
provider/model from its implementer.

Task routing intent uses an optional `role`. Use
`role: "planning"` only with `openDecision` naming the unresolved design
decision; planning without it is rejected. For example, create a planning task
with `role: "planning"`, `openDecision: "Choose whether this API accepts a
single id or a list"` while that choice is open. Once
the choice is approved, implement it with `role: "implementation"` and omit
`openDecision`. A writer count or shared contract alone never calls for a
planning task.

Conductor owns worker profiles in `<PASEO_HOME>/plugin-data/conductor/profiles.json`;
create and edit them in Podium › Profiles. Each profile has a provider/model,
optional thinking and permission mode, `roles`, a `size` (`small`, `medium`, or
`large`), “When to use” notes, and free-text instructions. Roles are
`exploration`, `implementation`, `planning`, and `review`. The notes guide the
Conductor's subject-matter match. Profiles without at least one role and a size
are unclassified, cannot be selected by routing, and show a warning in their
Profiles card. The Conductor prefers the smallest eligible size for the role;
choosing a larger size produces a warning in `warn` mode or requires an
evidence-backed override in `strict` mode. A profile's instructions are
delivered to its task agents in a clearly delimited section. They cannot
override user instructions, repository rules, write scope, or the permission
ceiling. Put skill names the agent should use in the instructions; Conductor
does not discover skills. Set routing in Podium › Profiles with the **Enforce
routing** switch: off is `warn` (the default), and on is `strict`. A missing
store means no profiles are configured. Unknown and stale IDs appear in
diagnostics.

When a profile is eligible, omitted worker fields resolve to the first eligible
route: the smallest size, then store order. Automatic routing does not read the
“When to use” notes, so the skill tells the Conductor to omit worker fields only
when exactly one eligible profile has the smallest size for the role, and to
name a profile chosen by its notes when several share that size. Omitted fields
never silently inherit the Conductor's model. For an explicit worker
choice, set `profile`, inline `provider`/`model`/optional `thinkingOptionId`, or
`profile: "inherit"` when no profile is eligible. Add `routing: {"reason":"..."}`
to explain the selection; the automatic route supplies its own concise reason.
Escalate only for a user choice, concrete capability gap, observed
model limitation after bounded corrective attempts, or no eligible configured
profile. Include `routing.override: {"category":"user-choice|capability-gap|observed-limitation|no-eligible-profile","evidence":"specific evidence"}`.
“Needs quality” is not evidence. Diagnose missing input, permission and sandbox
problems before blaming the model.
When no profile is eligible, explicit `profile: "inherit"` requires
`routing.reason`; strict mode also requires a valid `no-eligible-profile`
override with specific evidence.

`warn` mode is the default: larger-than-eligible by size, unclassified, ineligible,
inline, or inherited choices are accepted with a warning in the acknowledgement
and attempt. `strict` rejects these choices without a valid override and
specific evidence. `define`, `loop` and `dispatch` validate worker choices;
dispatch revalidates when the catalog revision changes. User-named profiles
remain authoritative subject to availability and the existing permission
ceiling. The permission mode is never selected inline: an explicit profile
`modeId` overrides the inherited Conductor mode; otherwise a task agent on the
same provider copies the Conductor's mode, and another provider starts in its
default mode. Attempts retain the effective launch choice, catalog revision, routing
reason, override and warnings. Podium task cards and reports show the worker
profile/model, selection reason and any override or warning.

`review: true` marks a read-only review task. A review task starts once each prerequisite is completed
or needs changes and receives their open findings and failed checks; other tasks
wait for completed prerequisites. Assignments carry the goal,
prerequisite reports, declared scopes/checks, and exact symphony/attempt identity.
Task agents call `report` or `block` for their existing assignment, then stop. They do
not create another symphony or claim the Conductor's task. The scheduler observes
settlement, starts dependents, and notifies the Conductor agent of blockers or the
completed score. Notifications wait until the Conductor can receive them.

`dispatch` with `retryTaskId` resumes a settled blocked task or retries a failed
task; a `needs-changes` task is resolved with `loop` instead. A failed task gets
at most 2 retries per loop (3 attempts), counted only from failed attempts in
that loop; then `dispatch` refuses and the Conductor asks the user. Blocker
resumes and nudges do not count, and failed retries do not use the loop budget.
Retrying an unconfirmed launch replays the same agent identity on the same
attempt and counts as a retry. A late report from the task agent replaces the
server's harness-failure report. Optional `note` adds retry guidance; `addWrites` adds paths to that task's
write scope for this and later attempts, subject to conflict checks. An unchanged
worker choice continues on the same agent when it can receive a message. For a
blocked attempt, a changed `profile` or inline
`provider`/`model`/`thinkingOptionId` starts a new agent on that attempt, even if
the previous agent is still available. Failed attempts continue on the same agent
only when the worker choice is unchanged and that agent is available; otherwise
Conductor creates a new agent. Replacement agents receive the full assignment and
a handoff with the previous report or block message, the Conductor note, and paths
in the attempt's write scope that changed. Each attempt records up to 50 changed
paths (and whether the list was truncated); paths are checkout-relative. The
observation hashes each write-scope path's content in the checkout, including
edits to untracked files, rather than a Git diff, and is bounded to 200 dirty
entries. When the checkout is not a Git work tree, Git fails, or the write scope
lists more than 200 dirty entries, the handoff says changed files are unknown
and asks the agent to review its write paths. A still-active task agent
cannot be replaced. Creation intent and agent IDs are saved before launch;
uncertain launch retries use the same SDK identity and never resend the initial
prompt to an existing matching child. Reload observes existing children rather
than replacing them.

For a `need: "scope"` diagnosis, retry with `addWrites` set to the requested paths,
or ask the user if they exceed the goal. For `input`, ask the user and put the
answer in `note`; for `model`, choose a different task agent; for `harness` (or
the older `none`), give a specific direction in `note`. Read `get` or open a task agent conversation only when
the notification summary does not explain the failure. Review granted paths and
their reasons in the attempts, and include them in the finish summary.

#### Loops

Each loop wakes the Conductor once (`loop-end:<N>`) with its verdict: it
succeeded, it needs changes with the blocking findings and failed checks, the
loop budget is used, or the blocking findings repeat the previous loop. Failed
and blocked tasks keep their per-task wake and are handled first. After a loop
needs changes, the Conductor reopens the owning tasks in the same symphony:

```bash
node "$CONDUCTOR_COMMAND" loop <<'JSON'
{"symphonyId":"<symphony UUID>","reason":"Fix review findings F1-F3","reopen":[{"taskId":"api","findings":["review#F1","review#F2"],"note":"Validate concertId before lookup.","after":["plan-2"]},{"taskId":"ui","findings":["review#F3"]}],"tasks":[{"id":"plan-2","title":"Plan the concertId validation","description":"...","dependsOn":[],"reads":["server","shared"],"writes":[],"checks":[]}],"deferred":[{"finding":"review#F4","reason":"Needs a user decision on the API shape"}]}
JSON
```

Findings are named `<reporter task>#<finding id>`; a bare id is accepted only
when one reporter used it. A reopened task continues on its agent, with that
agent's worker choice, when the agent is idle and can receive a message;
otherwise a new agent starts with the previous report and the same worker
choice. `reopen` may provide a worker override (`profile` or inline
`provider`/`model`/`thinkingOptionId`); it must include `routing.reason`, and
uses the same routing validation and override evidence as task definition. A
check or review failure is not a harness failure for switching models. An active agent is never replaced. Its prompt carries the full finding
objects, captured when `loop` is accepted. `note` and `addWrites` work as on a
retry and are kept with the loop until the task starts, and `after` adds
prerequisites for this loop only; `after` edges must not form a cycle with
`dependsOn`. `tasks` appends new tasks in a new score revision. Every transitive
dependent of a reopened task, including the review, re-runs in the new loop with
a short re-check prompt. A re-running review, including an explicitly reopened
one and a replacement agent on a retry, receives the previous findings. When the
findings or failed checks would exceed the saved prompt limit, the prompt keeps
each finding's id, owner and first path, shortens each failed check name, and
points to the saved reports for the rest. If a prompt still doesn't fit, the
task doesn't start and the Conductor is woken to ask the user and finish with
`unresolved`.

`loop` is accepted only from the symphony's Conductor, after the current loop
ended needing changes with no failed, blocked, or running tasks, when every
blocking finding and `needs-changes` task is reopened or listed in `deferred`
with a reason, and when the new score, the added write scopes, and the attempt
limit pass validation. A refused `loop` changes nothing. A deferred item stays
open: later loop wakes list it again, and each later `loop` must reopen or defer
it again.
`orchestrate` accepts `maxLoops` from 1 to 5 (default 3). A loop past the budget
needs `approval: {loops, userAnswer}` with the user's own words; the approval is
recorded and shown in History. The server cannot verify it; the budget makes the
Conductor stop and ask.

`finish` requires every task's latest attempt to be completed and settled. If
the user chooses to stop with open work, `finish` accepts
`unresolved: [{finding | taskId, reason}]` covering every open blocking finding
and non-completed task once every task agent has stopped and settled; the
symphony then ends as failed, lists them, and releases the stopped tasks' scope.

Task agents request scope while their attempt is running:

```bash
node "$CONDUCTOR_COMMAND" widen --agent "$CONDUCTOR_AGENT_ID" --socket "$CONDUCTOR_SOCKET" <<'JSON'
{"symphonyId":"<symphony UUID>","attemptId":"<attempt UUID>","paths":["shared/schema.ts"],"reason":"My change broke the exported schema used by typecheck"}
JSON
```

A refusal leaves the scope unchanged. The task agent reports `need: "scope"` and
`requestedWrites`; the Conductor can retry with `addWrites` when appropriate.

### Agent commands and compatibility

New agents receive an explicit command in their system guidance. Its helper is
bound to the agent and daemon before the first interactive turn, so shell tools
can use it even when they do not inherit session environment variables. No manual
agent registration is needed. Paseo's SDK handles agent creation and lifecycle;
this helper sends Conductor-specific symphony and report operations.

Task-agent prompts explain the assignment and which Conductor action to use, but
do not repeat tool-call JSON samples or shell commands. Agents use the MCP tool
schemas and descriptions for report, widen, and block rules. When MCP tools are
unavailable, the `[Conductor agent commands]` block in the agent's system
instructions gives the shell helper and its `help` command. The public
session-opening hook also supplies these convenience variables on supported Unix
hosts:

- `CONDUCTOR_COMMAND`: generated Node helper path (bound to new agents).
- `CONDUCTOR_SOCKET`: this daemon's owner-only Unix socket.
- `CONDUCTOR_AGENT_ID`: source agent identity.

Newly created agents receive command guidance appended to their existing custom
system prompt. The per-agent helpers persist under `agent-commands/` in Conductor's
data directory across plugin reloads. Provider/model, mode, permissions, and other
environment values are preserved. Existing running sessions keep their environment; they can supply
`--agent <id> --socket <path>` explicitly or receive variables on their next session
opening. The plugin does not restart agents or the daemon.

```bash
node "$CONDUCTOR_COMMAND" help
node "$CONDUCTOR_COMMAND" start <<'JSON'
{"key":"fix-toolbar-20261005","title":"Fix the toolbar","goal":"Apply and verify the requested toolbar fix"}
JSON
```

The older `start`/`claim` workflow tracks only the calling agent; it is not
orchestration. Start returns the symphony. Omitting tasks creates one assignment named `work` with
conservative checkout-wide read/write scope. A key is stable per source agent:
repeat identical input after lost acknowledgement; changed input under that key
is rejected. Distinct work needs a distinct key.

```bash
node "$CONDUCTOR_COMMAND" claim <<'JSON'
{"symphonyId":"<returned UUID>","taskId":"work"}
JSON
```

Save the returned `attempt.id`, then work through normal agent tools. Claims are
recorded before work starts. Repeating a claim returns its unfinished attempt.
Conflicts across recorded symphonies in the same checkout block new claims; blocked or
interrupted work retains ownership. Scopes coordinate these assignments, not
external processes or file sandbox permissions.

```bash
node "$CONDUCTOR_COMMAND" report <<'JSON'
{"symphonyId":"<symphony UUID>","attemptId":"<attempt UUID>","report":{"outcome":"completed","summary":"Applied the fix","evidence":["Describe actual changed behavior and verification"],"checks":[]}}
JSON
node "$CONDUCTOR_COMMAND" finish <<'JSON'
{"symphonyId":"<symphony UUID>","summary":"Describe the result and remaining limitations"}
JSON
```

Multi-task starts supply `tasks` with `id`, `title`, `description`, and optional
`dependsOn`, `reads`, `writes`, `resources`, and `checks`. Paths are literal and
checkout-relative. Prerequisites need completed reports before a task is claimed.
Every declared check must appear by its exact name in the report with
`status: "passed"` and nonempty `detail` before completion. Otherwise report
needs-changes, failed, or block the task; never invent a pass. Retrying failure requires `claim` with
`retry: true`, creates a new attempt, and preserves the old report.

`block` takes `symphonyId`, `attemptId`, and `message`; ask any question in the
source conversation. Reclaim resumes a blocked attempt. `get` takes `symphonyId`;
`list` needs no input and returns that source's symphonies. Exact report/finish retries are idempotent;
changed terminal reports and superseded attempt IDs are rejected. Finish requires
completed reports for every task, or `unresolved` covering everything open. Run help for complete examples.

The transport trusts the daemon OS account through a private directory and
mode-0600 Unix socket; it does not isolate agents sharing that account. Declared
source identity and concert are checked against Paseo on mutation; a source may
update only its own recorded symphonies. No HTTP port is exposed. Request/response limits
are 256 KiB / 2.2 MB, with 16 pending commands, a 12-second response deadline, and
15-second CLI timeout. Uncertain acknowledgement is not proof of failure: inspect
the symphony and reuse its identities.

A callback or an `agents.*` RPC supplies the subprocess-lifetime SDK connection. A cold
command before either fails explicitly; agent lifecycle hooks normally supply it
before work. Unix socket paths must be at most 100 bytes. Monitoring remains
available when command transport is unsupported or unavailable.

### One attention queue

The default **Needs attention** view combines questions, permissions, failures,
and reminders. Use **Next item** to move through the queue, or switch to
**Running**, **Inactive**, or **All** for other activity.

Search by title, project, concert, or provider. The global podium covers the
selected host; the workspace panel covers the current concert. Parent/child
relationships and **Open parent** help you follow delegated work.

### Questions and permissions

Answer supported questions and permission requests directly. Conductor checks
the current request before sending, records response actions, preserves drafts
with their original request, and disables responses while the host state is stale.

Claude plan approvals and unsupported question formats open the agent for native
controls. Sending an answer does not confirm that work resumed.

### Reminders, snooze, and follow-through

- View and clear manual reminders in the attention queue.
- Snooze items for 15 minutes, unsnooze them, or use **Show snoozed** to reveal them.
- Inspect recorded turn outcomes and **Recent actions** to follow responses.
- Open agents in their workspaces and archive eligible inactive agents with a
  confirmation. Archiving is blocked when an agent is active, has a pending
  request, has child agents, or the directory is too incomplete to check safely.

Snooze affects the queue; Paseo controls notifications. Reminders, snoozes,
receipts, and turn outcomes persist under `$PASEO_HOME/plugin-data/conductor`
(default `~/.paseo/plugin-data/conductor`). Idle/closed status or a turn outcome
does not establish task completion; review the output and required checks.

## Requirements

- Compatible Paseo app and daemon versions. The range in
  [paseo-plugin.json](paseo-plugin.json) is
  `>=0.10.3 <0.11.0 || >=0.11.0-beta.3 <0.12.0` (0.10.3+ in the 0.10 line,
  or the 0.11 line starting at beta.3).
- Git available on the daemon host for installation from this repository.

Paseo supplies runtime libraries; Git installation needs no manual `npm install`.

## Installation from Git

Install on each daemon you want to monitor; the podium stays scoped to the selected
host. Plugins run as trusted code with the daemon user's access to its machine.

Paseo clones this repository and installs the `conductor/` subdirectory selected
by `:conductor`. You do not need a local checkout or a manual build.

### GUI (Git source)

1. Connect to the target host in Paseo and open **Settings → Plugins**.
2. Turn on **Enable plugins** if it is off.
3. Paste this URL into **Plugin source**:

```text
https://github.com/josephjs1dev/paseo-plugins.git:conductor
```

4. Select **Install plugin** and confirm that `conductor` reports `running`.
5. Open **Conductor** from the sidebar, or **Open podium: all concerts** /
   **Open podium: this concert** in the Command Center (**⌘K** on macOS, **Ctrl+K** elsewhere).

### CLI (Git source)

Enable plugins with the GUI switch, or set root `pluginsEnabled: true` in the
target daemon's `config.json`, preserving other settings, and run
`paseo reload --json`. `paseo daemon status --json` reports the local daemon's
home, where that file lives. Then install:

```bash
paseo plugin install github:josephjs1dev/paseo-plugins:conductor
paseo plugin ls
```

The HTTPS URL shown above also works in the CLI. Git installs use the repository's
default HEAD; append `--ref <branch-tag-or-commit>` to select an initial revision.

Expect ID `conductor` with status `running`. For another daemon, use
`paseo --host <url> plugin ls` and the same prefix for other commands. Edit
configuration on that daemon's machine.

See the [Paseo plugin guide](https://paseo.sh/docs/plugins) and
[source reference](https://paseo.sh/docs/plugins/reference#plugin-sources).

### Updates and troubleshooting

Update a Git installation, reload source, or inspect daemon-side errors:

```bash
paseo plugin update conductor
paseo plugin reload conductor
paseo plugin logs conductor
```

**Settings → Plugins** also provides reload, logs, removal, and an enable switch.
For a missing podium, check the selected host, plugin status, app/daemon versions,
and **Settings → Sidebar** visibility. Failed refreshes keep previous items;
reconnect and refresh before responding, or inspect the agent directly.

## Development

Use Node **22.13 or later** and npm. From the repository root:

```bash
cd conductor
npm ci
npx playwright install chromium
npm run check
```

`check` runs type checking, ESLint, Prettier, unit tests, and Playwright tests.
Browser tests start the fixture preview automatically and need Chromium, without
a real daemon or provider credentials.

For focused checks, use `npm run typecheck`, `npm test`, or `npm run test:ui`.
`npm run preview` serves fixtures at `http://127.0.0.1:5178`;
`npm run build:preview` builds them. `npm run audit` checks high/critical advisories.

| Path                  | Responsibility                                                              |
| --------------------- | --------------------------------------------------------------------------- |
| `index.client.tsx`    | Client entry point and feature registration.                                |
| `client/podium/`      | Podium shell and shared navigation.                                         |
| `client/agents/`      | Agent snapshots, queue, request UI, drafts, navigation, and subscriptions.  |
| `client/symphonies/`  | Symphony score, task progress, blockers, and reports.                       |
| `server/agents/`      | Agent snapshots, request delivery, turn observation, and guarded archiving. |
| `server/symphonies/`  | Symphony orchestration, execution, persistence, and recovery.               |
| `server/entrypoints/` | Server RPC registration and command handling.                               |
| `server/paseo/`       | Paseo SDK integration and host adapters.                                    |
| `shared/`             | Runtime-neutral Zod RPC contracts, request models, filters, and hierarchy.  |
| `tests/`              | Unit tests, fixture preview, browser tests, and optional host smoke tests.  |

- Read the repository's [AGENTS.md](../AGENTS.md),
  [security rules](../.agents/rules/security.md), and
  [TypeScript styles](../.agents/rules/typescript/coding-styles.md). For UI changes,
  also follow the [frontend styles](../.agents/rules/typescript/frontend-styles.md).
- Preserve the client/server/shared boundaries and keep production code on the
  public Paseo SDK. Filesystem persistence belongs in `server/`.
- Use React Native primitives, Paseo theme colors, and compact layouts. Keep
  browser-specific preview code in the test harness.
- Preserve 0.10/0.11 navigation compatibility; update the manifest requirement
  when adopting APIs that change the supported range.
- Validate request identity and current state before responding or archiving.
  Preserve response deduplication, stale-state guards, native-control fallbacks,
  and parent/child checks. Test observable behavior with synthetic fixtures.
- Keep dependencies pinned and update this plugin's `package-lock.json` when
  changing them. Release subscriptions and other resources during cleanup.
- Run `npm run check` in `conductor/` and `git diff --check` before submitting.

### Local checkout installation

With plugins enabled, install your checkout on the daemon host:

```bash
paseo plugin install /absolute/path/to/paseo-plugins/conductor
```

If ID `conductor` is already installed, use `--id conductor-dev` and that ID in
subsequent commands, or remove the previous installation. After editing:

```bash
npm run check
paseo plugin reload conductor
paseo plugin ls
```

Check both podium surfaces, supported responses, native fallbacks, and stale states.
For UI changes, verify wide/compact layouts and light/dark themes.

Optional `npm run test:host` and `npm run test:client` need `CONDUCTOR_TEST_URL`
pointing to a disposable daemon at `ws://127.0.0.1:<port>/ws` with ID `conductor`
running. The client test needs its web app; the host test installs a fixture
provider and creates temporary workspaces/agents. These are separate from `check`.

### Symphony storage and recovery

Symphony records and immutable goal context are stored under
`plugin-data/conductor/symphonies/` and `artifacts/`. Definitions, attempts,
blockers, report hashes, and final summaries are stored together. After upgrading,
delete `runs/`, `run-write-lock`, and `artifacts/` under the Conductor plugin data
directory, then run **Install conductor skills** again. Upgrade while no Podium answer is being sent: request keys changed, so a
native-answer receipt recorded before the upgrade no longer blocks a repeated send. Git metadata and the
tracked-diff/status fingerprint are context, not settlement proof. Attempts stored before
loops existed load as loop 1, and their reports keep their original meaning.

Bounds are 200 symphonies and 200 context artifacts (including orphans), 40 tasks,
120 attempts per symphony, 24 plan revisions (one per plan, plus one per loop
that appends tasks), 1–5 loops (default 3; more only with recorded user
approval), 2 failed retries per task per loop, 24 findings per report, a
2,000,000-byte envelope, and 128,000-byte context. Field/command bounds also apply. Limits refuse new history
instead of pruning evidence. Corrupt records are isolated from healthy reads and
the Symphonies view. Incomplete coverage blocks resource claims because existing
ownership cannot be established.

`SymphonyStore` serializes updates, fences processes with `symphony-write-lock`, checks
versions, syncs files and Unix directories, and atomically replaces snapshots.
Context is durable before publication. The socket admits one live server; another
installation cannot steal it. Graceful reload releases the socket/hooks.
Unreported running attempts become blocked and retain their IDs and claims until
the source resumes or reports them. Turn endings and archive events never
manufacture completion.

Interrupted processes may leave `symphony-write-lock` or `commands.sock`. Neither is
automatically stolen/deleted. For manual recovery, disable every Conductor
installation using the root, confirm its processes exited, and back up the records.
Inspect unresolved attempts before removing a stale lock/socket and reloading.
Never remove a live owner's files or native-answer receipts.

There is no automatic purge, but Conductor can delete one finished symphony
at a time. Deletion is refused while an attempt is running or blocked, while an
agent launch is unsettled, and for symphonies that are not complete or failed. Deleting
a symphony removes its snapshot and removes its content-addressed context artifact
only when no remaining symphony references it; shared context is retained. Offline
maintenance must still preserve unresolved claims.
Symphonies dispatch real children and observe settlement through the host.
Task agents run their own checks and submit evidence. Cancellation of a symphony, isolated
worktrees, parallel writers, and recurring schedules are not part of this release.
