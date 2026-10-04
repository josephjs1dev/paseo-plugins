# Conductor for Paseo

Check agents and answer blockers from one inbox. Conductor combines a host-wide
waiting queue, workspace context, and a composer pill. It works with existing
Paseo agents; it does not require a job setup or launch additional workers.

## What version 1 does

- Groups requests by project or workspace, with search and exactly five filters:
  **Waiting**, **Needs attention**, **Running**, **Inactive**, and **All**.
  The header counts distinct agents; filter counts refer to inbox rows
  because one agent can have several requests.
- Shows child agents beneath visible parents, including across workspaces.
  A filtered-out parent does not hide its child; a parent label and navigation
  link preserve context. Families inherit the priority of their waiting children.
- Archives inactive agents after confirmation and a fresh check. Agents with
  unarchived children are protected from Paseo's cascading parent archive.
- Shows each pending request separately, including waiting age, agent, provider,
  workspace, and native request details. Open the agent for conversation history.
- Answers Paseo's normalized single/multiple-choice and free-text questions.
  Tool requests use the provider's explicit actions, or Allow once/Deny when
  no custom actions exist. A chosen tool action needs a final confirmation.
- Opens the agent for unsupported forms, secret questions, plan/mode approvals,
  and provider-specific controls. Navigation availability depends on the client.
- Preserves request-specific drafts, selection, search, and queue position while
  navigating within the loaded plugin. Next waiting selects another unresolved
  request without clearing the original draft.
- Persists snooze and response receipts. Existing manual reminders can be cleared;
  the main actions no longer offer a “Needs my reply” button.
- Records the latest observed turn outcome on the daemon independently of
  Paseo's unread/attention state, including when no Conductor client is open.
- Shows uncertain delivery explicitly and prevents Conductor from blindly
  resending an answer after a lost acknowledgment or backend restart.
- Provides a sidebar entry, a workspace panel, Command Center actions,
  and a per-agent composer pill. Desktop uses a list/detail layout; compact
  clients use a list/detail/back flow. Paseo 0.11 adds a live attention count in
  the sidebar; on 0.10.3 the count is available inside the inbox.

Turn ended means a recorded native response ended, not that code or tests were verified.
Questions embedded in normal prose are not automatically classified as native
blocking requests. Open the agent to respond to those messages.

Conductor's snooze affects its queue only. Paseo retains control of native
notifications. This release adds no custom background push, automatic approval,
agent launching, worktree creation, or task scheduling.

## How agents are discovered and updated

Conductor reads the selected host's complete paged agent directory on its first
refresh, within the limits below. Every unarchived agent is eligible, including
agents already running before installation, idle agents, and child agents. There
is no registration step and no requirement to launch an agent through Conductor.
It does not discover standalone harness sessions that Paseo does not manage.

The connected client subscribes to Paseo's agent and workspace directories.
Snapshots and updates invalidate the inbox after a 500 ms debounce; surfaces
share the subscription. Paseo's SDK restores owned subscriptions on reconnect.
The inbox also refreshes every 15 seconds while active, and composer pills poll
every 30 seconds while the plugin client is loaded. Those full refreshes cover
missed events and agents outside the subscription's page window. This is a
current-state view of statuses and pending permissions, not a token-stream log
or a persistent history of every transition. Separate daemon lifecycle hooks
retain the latest observed turn outcome even when the client is disconnected.

Waiting shows native questions and permissions. Needs attention shows errors
and existing manual reminders; errors take priority over pending questions.
Running shows active work. Inactive combines idle and closed sessions while
preserving those distinct labels on each card. All includes everything, including
snoozed items. An empty Waiting view does not mean there are no agents: counts,
Inactive/Running/All, and
the **View all agents** action expose existing work. Natural-language questions
in an ordinary assistant message require opening the conversation.

Snooze is a queue preference, not a status. Waiting and Needs attention can show
deferred items with **Show snoozed**; Running and Inactive are never hidden by a
snooze. Turn outcomes remain on cards and in details rather than in a separate tab.

## Children and archiving

Parentage comes from Paseo's `paseo.parent-agent-id` relationship. In All, a
matching child B is indented under A; in Waiting, B still appears when a running
A is filtered out, with **Child of A** and **Open parent**. Each request remains
individually answerable. Grouping follows the visible family root; each child's
own workspace remains visible. Missing parents use an explicit unavailable label.
Harness-internal workers that are not exposed as Paseo agents are not inferred.

Inactive agents offer **Archive agent → Confirm archive**. Archiving removes
the agent from active Paseo lists, not its workspace files. Conductor checks a
fresh agent fingerprint, pending work, and the complete child directory before
calling Paseo's archive API. It refuses stale/running/waiting agents, parents with
unarchived children, and incomplete directories. Archive or detach children in
Paseo first; Conductor does not silently cascade or detach them. The public API
has no atomic conditional archive, so a concurrent mutation can still race the
final native call. An uncertain acknowledgment is shown without automatic retry.

## Runtime state, turn outcome, and task completion

These are separate signals:

- **Running / Idle / Closed / Failed** describe current runtime state. Closed
  sessions are never folded into Idle. An unread flag is not a completion signal.
- **Turn outcome** records completed, canceled, or failed responses. An Idle or
  Closed agent can have a recorded outcome. The detail shows the outcome and
  when it was observed; outcomes are not additional runtime states or filters.
- **Task completion is not verified by Conductor.** A completed response may
  contain unfinished work or a question. Acceptance criteria, test evidence, and
  review are required to establish that the actual assignment is complete.

The daemon listens to `agent.turn_started` and `agent.turn_ended` and stores only
turn identity, outcome, session identity hash, and timestamps. It does not infer
completion from prose or `requiresAttention`. Acknowledging output and reloading
the plugin do not erase a recorded outcome. A new turn, a changed prompt, or a
different provider session prevents an old completion from carrying forward.

An agent with no recorded terminal event shows **Outcome unknown**. That includes
older agents from before this tracking was installed and turns whose end was
missed while the plugin/daemon was stopped. Unread flags and ordinary conversation
messages cannot reliably reconstruct those outcomes. A damaged record produces
an explicit history warning while keeping the agent visible. The journal retains
one latest record per agent, not a full transcript or an unlimited turn history.

## Install

Both the app and daemon need **Paseo 0.10.3 or a compatible 0.11 build**. The
manifest accepts `>=0.10.3 <0.11.0 || >=0.11.0-beta.3 <0.12.0`. Isolated-host
integration and the real web client were tested on **0.10.3** and
**0.11.0-beta.3**. Development types remain pinned to 0.11.0-beta.3.

On 0.10.3, Conductor uses the native surface/sidebar APIs. On 0.11 it uses the
new screen/sidebar APIs. Both paths open the full host-wide inbox and preserve
workspace panels, Command Center navigation, composer pills, and responses.
This is a runtime capability fallback, not only a lowered version check.

On the intended daemon machine, enable plugins in Paseo settings, then run:

```sh
paseo plugin install /absolute/path/to/paseo-plugins/conductor
paseo plugin ls conductor
```

Plugins run trusted, unsandboxed code. Review the source before installation.
Paseo supplies the runtime libraries; no dependency installation is required to
load this source directory. Keep the directory at its installed path.

Select that host in Paseo and open **Conductor** in the sidebar. The Command
Center also offers **Open Conductor inbox** and **Open workspace inbox**. The
workspace panel is available in Explorer or as a workspace tab.

After updating the source:

```sh
paseo plugin reload conductor
paseo plugin logs conductor
```

Installation and reload are per daemon. Use `--host` or `--home` explicitly
when targeting a different daemon. Do not restart a daemon just to reload source.

## Response and storage behavior

The backend refreshes the exact agent/request before answering. A request key
includes agent/session identity and a fingerprint of the native payload. An
exclusive, synced file claim is written before dispatch; a completed receipt
is saved afterward. Two clients cannot bypass that claim by choosing different
answers to the same request. Claims also protect concurrent plugin backends.

An exception after dispatch is **Delivery uncertain**, not permission to retry.
Open the native agent to inspect its current request. A corrupt claim fails
closed. Missing agents or changed request content make an answer stale.
An acknowledged answer does not prove that the worker resumed successfully.

Local metadata lives under:

```text
<PASEO_HOME>/plugin-data/conductor/
  annotations/     request snoozes and agent reminder flags
  receipts/        response fingerprints, identities, timestamps, delivery states
  turns/           latest observed turn metadata per agent, without transcript text
  recent.json      bounded index of the latest 30 response operations
```

Question bodies, answers, tool inputs, and conversation text are **not persisted**
by Conductor. Draft text stays in client memory and is lost on plugin/app unload.
Receipts are deliberately retained across reloads to fence uncertain requests;
there is no automatic receipt deletion. Never remove receipts while their native
requests could still be pending. Recent-action display is bounded and does not
rescan the full receipt directory.

Directory views page at most 2,000 agents/workspaces and expose truncation rather
than claiming a complete count. Known pending agents retained by a client are
queried directly outside that page window. Up to 20 requests per agent and 6,000
rows are displayed. Open the agent for the complete native conversation.

## Development and validation

```sh
cd conductor
npm ci
npx playwright install chromium
npm run check
npm run audit
npm run build:preview
```

`check` runs strict TypeScript checks, typed ESLint, formatting, Node tests, and
browser interaction tests. Browser tests render the actual React Native view
through React Native Web with synthetic data; they do not contact real agents.
`npm run preview` opens the same development fixture on `127.0.0.1:5178`.
Preview and browser-only TypeScript configs include DOM types separately; plugin
source does not.

Development installs standalone React Native declarations and React Native Web,
not React Native's Metro/Jest/native build toolchain. `.npmrc` disables automatic
peer installation because Paseo supplies that runtime. SDK, React, and protocol
peers used by the plugin are pinned explicitly. The standalone declarations
cover the conservative API subset used here; source was additionally checked
against the host-aligned React Native 0.81.5 declarations. This avoids the
unpatched `braces` advisory in the unused native development toolchain without
changing Paseo's runtime or filtering audit results.

### Isolated host smoke test

Use a disposable daemon home, a loopback port, relay disabled, built-in providers
disabled, and plugins enabled. Install Conductor into **that test daemon** first.
Then run from `conductor/`:

```sh
CONDUCTOR_TEST_URL=ws://127.0.0.1:YOUR_TEST_PORT/ws npm run test:host
CONDUCTOR_TEST_URL=ws://127.0.0.1:YOUR_TEST_PORT/ws npm run test:client
```

The harness installs the fixture provider under `tests/host/provider`, creates
one synthetic question, checks snooze/response behavior and plugin reload,
verifies completion survives acknowledgment/reload and a new turn clears it,
then archives its test resources and removes the fixture provider. It uses no
model credentials, external tools, or network calls beyond the local daemon.
Only run it against a disposable test instance. The test harness uses the SDK's
low-level plugin RPC transport; production code uses public plugin/Paseo APIs.
`test:client` opens that daemon's bundled web client in Chromium and checks that
its sidebar opens the inbox at desktop and compact sizes. Enable the daemon's
web UI before running it. Run both scripts against each supported release to
check the real host contracts as well as the unit-test fixtures.

The browser suite covers wide/light and compact/dark layouts, preserved drafts,
answer/next navigation, native fallback, unknown delivery, stale data, snooze,
search, empty/incomplete states, keyboard focus, and horizontal reflow. Physical
iOS/Android devices and live model-provider permission variants require separate
verification before claiming support for those exact combinations.

## Structure

`client/` contains React Native views and their lifecycle. `shared/` contains
runtime-neutral schemas and question/inbox rules. `server/` contains the Paseo
adapter, request verification, and durable metadata I/O. The runtime interface
is small so future orchestration does not have to depend on Paseo object types
throughout the product.

Design references: [Agent Crew](https://github.com/omercnet/paseo-plugins/tree/01d10b49c63aa800b1385d9b950cc7cad6766d2d/agent-crew),
[Progress](https://github.com/stevecastaneda/paseo-plugins/tree/94f1dfc707bbf37d8de7f4d02d3acc70fc5a7e58/progress),
and [Agent Monitor](https://paseo.cafe/plugins/agent-monitor/). Conductor does not
require those plugins or access their private state.
