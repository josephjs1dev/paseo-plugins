# Conductor

Conductor adds a Paseo inbox for finding blockers, responding to agents, and
following work across projects and workspaces on the selected daemon.

## Features

### One attention queue

The default **Needs attention** view combines questions, permissions, failures,
and reminders. Use **Next item** to move through the queue, or switch to
**Running**, **Inactive**, or **All** for other activity.

Search by title, project, workspace, or provider. The global inbox covers the
selected host; the workspace panel covers the current workspace. Parent/child
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

Install on each daemon you want to monitor; the inbox stays scoped to the selected
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
5. Open **Conductor** from the sidebar, or **Open Conductor inbox** / **Open
   workspace inbox** in the Command Center (**⌘K** on macOS, **Ctrl+K** elsewhere).

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
For a missing inbox, check the selected host, plugin status, app/daemon versions,
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

| Path                          | Responsibility                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `index.client.tsx`, `client/` | Inbox surfaces, queue and request UI, drafts, navigation, and subscriptions.             |
| `index.server.ts`, `server/`  | Inbox snapshots, request delivery, persistence, turn observation, and guarded archiving. |
| `shared/`                     | Runtime-neutral Zod RPC contracts, request models, filters, and hierarchy.               |
| `tests/`                      | Unit tests, fixture preview, browser tests, and optional host smoke tests.               |

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

Check both inbox surfaces, supported responses, native fallbacks, and stale states.
For UI changes, verify wide/compact layouts and light/dark themes.

Optional `npm run test:host` and `npm run test:client` need `CONDUCTOR_TEST_URL`
pointing to a disposable daemon at `ws://127.0.0.1:<port>/ws` with ID `conductor`
running. The client test needs its web app; the host test installs a fixture
provider and creates temporary workspaces/agents. These are separate from `check`.
