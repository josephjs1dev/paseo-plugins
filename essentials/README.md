# Paseo Essentials

Essentials adds subscription limits, token history, workspace usage, and coding
CLI maintenance to Paseo.

## Features

### Subscription limits

The **Provider usage** workspace header button shows ChatGPT/Codex, Claude, or
OpenCode Go quota windows and reset times. Switch providers in the popover to
inspect an account. The header shows the **5-hour remaining balance** when that
window is reported; otherwise it shows the lowest remaining reported quota.
The popover keeps all available windows, including weekly and model-specific limits.

Quota lookup uses Codex's ChatGPT login or OpenCode Go's connected account on the
daemon host. Pi contributes history using those providers. Supported Codex
accounts also show banked reset availability and expiration, with **Use reset**
requiring confirmation before spending one.

Claude reads subscription usage from Anthropic's OAuth usage endpoint, using
the daemon's `CLAUDE_CODE_OAUTH_TOKEN` or Claude Code's `.credentials.json` under
`CLAUDE_CONFIG_DIR` (default `~/.claude`). Set `CLAUDE_USAGE_AUTH_FILE` to use an
explicit credentials file. The login needs `user:profile` access; inference-only
tokens and Anthropic API keys cannot read subscription limits. Expired credentials
require signing in through Claude Code again. Essentials never refreshes or rewrites
Claude credentials and does not read macOS Keychain-only logins. On those hosts,
provide a supported token or credentials file to the daemon.

Missing quota windows are omitted, never treated as unused quota.
The OAuth endpoint is not a stable public API. Its request and response shapes were
checked against [CodexBar's OAuth implementation](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift).

### Token history and workspace usage

The **Workspace usage** header button summarizes usage for the current workspace.
Open **Usage history** from a usage popover to explore:

- Daily charts over 7 or 30 days, scoped to the workspace or entire host.
- Input, cached, output, and reasoning tokens where the source records them.
- Breakdowns by model and session, including the originating coding CLI.
- Recorded cost estimates and estimated Codex credits where rates are available.

History combines native Codex and Claude Code session logs, Pi records for ChatGPT
and OpenCode Go, and OpenCode Go database records.
Workspace attribution uses the session's working directory; records use UTC days
and the cache retains 90 days. Unreadable sources produce partial-data warnings.

Claude history reads `<CLAUDE_CONFIG_DIR>/projects` (default `~/.claude/projects`),
with `CLAUDE_USAGE_PROJECTS_DIR` available as an explicit projects-directory override.
It works independently of subscription login and includes local Claude Code usage
regardless of how those sessions were billed. Parent and subagent requests are
counted in their recorded session, with repeated response snapshots counted once.
Input includes cache reads and cache creation; cache reads are also shown separately.
Claude logs do not provide a separate reasoning total or a billed cost, so no cost
is inferred. Only usage metadata is retained, not prompts or responses.

The workspace popover includes provider icons, 7/30-day totals, input/output/cache
counts, model and session details, and a manual history refresh. Claude can also
open the full history view directly from its quota popover.

Cost and credit estimates are not billed charges. Credits cover known model
rates and exclude speed and plan adjustments.

### Harnesses

Open **Harnesses** from the sidebar or Command Center to compare installed and
latest stable Codex, Claude Code, OpenCode, and Pi versions and update recognized
installations.
You can also refresh provider model discovery and supported CLI caches, then
search the model catalog.

Claude Code supports updates for recognized native and global npm installations.
Native updates install the checked version with `claude install <version>`; npm
updates use the detected installation prefix. Homebrew, other package managers,
and custom launch wrappers require their original installation manager.
Claude model refresh uses Paseo provider discovery without a separate CLI cache
command. See [Claude Code setup](https://code.claude.com/docs/en/setup) for
installation and update details.

Maintenance runs on the selected host. Unrecognized installations show guidance.
Finish active work before updating; existing sessions may need reopening.

## Requirements

- Paseo **0.9.2+** on both the app and daemon, as declared in
  [paseo-plugin.json](paseo-plugin.json).
- Node **22.13+** on the daemon host for OpenCode history (`node:sqlite`).
- The matching Codex, Claude, or OpenCode Go login for quota; local records for history.
- Git available on the daemon host for installation from this repository.

Paseo supplies runtime libraries; Git installation needs no manual `npm install`.

## Installation from Git

Install on each daemon where you want these tools. Plugins run as trusted code
with the daemon user's access to its machine.

Paseo clones this repository and installs the `essentials/` subdirectory selected
by `:essentials`. You do not need a local checkout or a manual build.

### GUI (Git source)

1. Connect to the target host in Paseo and open **Settings → Plugins**.
2. Turn on **Enable plugins** if it is off.
3. Paste this URL into **Plugin source**:

```text
https://github.com/josephjs1dev/paseo-plugins.git:essentials
```

4. Select **Install plugin** and confirm that `essentials` reports `running`.
5. Open a workspace for the usage buttons, or open **Harnesses** from the
   sidebar.

### CLI (Git source)

Enable plugins with the GUI switch, or set root `pluginsEnabled: true` in the
target daemon's `config.json`, preserving other settings, and run
`paseo reload --json`. `paseo daemon status --json` reports the local daemon's
home, where that file lives. Then install:

```bash
paseo plugin install github:josephjs1dev/paseo-plugins:essentials
paseo plugin ls
```

The HTTPS URL shown above also works in the CLI. Git installs use the repository's
default HEAD; append `--ref <branch-tag-or-commit>` to select an initial revision.

Expect ID `essentials` with status `running`. For another daemon, use
`paseo --host <url> plugin ls` and the same prefix for other commands. Edit
configuration on that daemon's machine.

See the [Paseo plugin guide](https://paseo.sh/docs/plugins) and
[source reference](https://paseo.sh/docs/plugins/reference#plugin-sources).

### Updates and troubleshooting

Update a Git installation, reload source, or inspect daemon-side errors:

```bash
paseo plugin update essentials
paseo plugin reload essentials
paseo plugin logs essentials
```

**Settings → Plugins** also provides reload, logs, removal, and an enable switch.
For missing UI, check the selected host, plugin status, and app version. For
unavailable quota, check the host's provider login; for empty history, check its
session records, selected provider, and working directory.

## Development

Use Node **22.13 or later** and npm. From the repository root:

```bash
cd essentials
npm ci
npm run check
```

`npm ci` uses this plugin's lockfile. `check` runs type checking, ESLint, Prettier,
and tests using temporary files and fake I/O, without real provider credentials.

| Path                          | Responsibility                                                               |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `index.client.tsx`, `client/` | Paseo app contributions, React Native UI, and query state.                   |
| `index.server.ts`, `server/`  | Daemon RPC handlers, provider calls, local history scans, and CLI processes. |
| `shared/`                     | Runtime-neutral Zod RPC contracts, parsing, and usage calculations.          |
| `tests/`                      | Collector, history, quota, maintenance, and navigation tests.                |

- Read the repository's [AGENTS.md](../AGENTS.md),
  [security rules](../.agents/rules/security.md), and
  [TypeScript styles](../.agents/rules/typescript/coding-styles.md). For UI changes,
  also follow the [frontend styles](../.agents/rules/typescript/frontend-styles.md).
- Keep filesystem access, credentials, network calls, and processes in `server/`.
  Shared modules must be independent of Node and React Native APIs.
- Use React Native primitives, Paseo theme colors, and compact layouts for UI.
  Cover loading, empty, partial-data, and error states.
- Validate external records and RPC data, bound I/O, and avoid logging credentials.
- Keep dependencies pinned and update `package-lock.json` when changing them.
  Update the manifest's Paseo requirement if a feature needs a newer host API.
- Before submitting, run `npm run check` here and `git diff --check`.

### Local checkout installation

With plugins enabled, install your checkout on the daemon host:

```bash
paseo plugin install /absolute/path/to/paseo-plugins/essentials
```

If ID `essentials` is already installed, use `--id essentials-dev` and that ID in
subsequent commands, or remove the previous installation. After editing:

```bash
npm run check
paseo plugin reload essentials
paseo plugin ls
```

Verify the changed flow and errors on the intended host. For UI changes, check
wide and compact layouts and light/dark themes; automated checks are separate.
