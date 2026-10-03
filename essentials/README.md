# Paseo Essentials

One Paseo plugin provides usage tracking, token history, and CLI/model maintenance. The runtime entries
`index.client.tsx` and `index.server.ts` compose feature contributions from
`client/` and `server/`, with shared contracts in `shared/`. Register future
features in these same entries and include their cleanup functions.

## Code organization

- `client/`: React Native views, a maintenance page, Paseo header buttons, and the history workspace tab.
- `shared/`: RPC schemas, provider metadata, quota normalization, log parsing,
  token deltas, and history aggregation. These modules contain no Node or UI APIs.
- `server/`: credentials, HTTP requests, processes, filesystem/SQLite access,
  caching, and persistence. Provider adapters live in `server/providers/`.
- `tests/shared/`: pure data-processing tests.
- `tests/server/`: integration tests with temporary files, SQLite databases,
  fake processes, and HTTP responses.

Tests are separate from the runtime directories for clarity. Colocated
`*.test.ts` files are also a valid TypeScript convention; Paseo does not require
this layout. ESLint enforces braces, spacing between logical blocks, and no
nested ternaries; Prettier handles wrapping and indentation.

### CLI updates and model discovery

Open **CLIs & Models (hostname)** from the sidebar or search for the same name in
the Command Center. Both open a host-level page with **Updates** and **Models**
views, available even with no workspace open. The label uses the daemon machine's
actual hostname, not a literal "server" label. Each daemon has its own sidebar
entry, keyed by its persisted server ID, so Paseo cannot merge different hosts
under one hostname. The page displays Paseo's selected host label and makes clear
that actions affect only that host. Paseo owns the page's host picker.
Maintenance does not add a workspace-header entry.

Host identification reads `PASEO_SERVER_ID` or `$PASEO_HOME/server-id` (with
`PASEO_HOME` defaulting to `~/.paseo`), without modifying the daemon identity.
If identification fails, the sidebar entry stays hidden and an unqualified
**CLIs & Models** command remains available; identification retries after 30 seconds.
It has one scroll area and adapts to compact layouts. Use the refresh
icon labeled **Check updates** to compare Codex, OpenCode, and Pi with their npm
stable release metadata. Checking never installs anything. Each row shows the
installed version and, when an update is available, the target version and a
download icon labeled **Update**. Icon buttons retain accessible labels and
show a spinner while their operation is running.

Updates use the detected installation: Codex's standalone `update`, Pi's managed
`update --self --no-approve`, OpenCode's standalone `upgrade`, or npm with the
verified installation prefix and an exact package version. Native Codex and Pi
updaters select their current latest release; the final executable version must
be at least the checked release. Prereleases and versions ahead of stable are
never replaced automatically. Homebrew, other package managers, and custom
launch wrappers show manual-update guidance instead of guessing a destination.
Single-executable provider command overrides and provider environment settings
are respected. The executable and installation are rechecked before updating.

Finish active work before applying an update. The plugin does not stop agents
or restart the daemon. Existing sessions may need reopening to use the new CLI.
One maintenance operation runs at a time per host; leaving the page does not
interrupt it. Returning shows its status. Reloading the plugin cancels its
subprocess work. Failed updates require another version check before retrying.
Commands run without a shell and have bounded output and timeouts; subprocess
output and provider environment values are never returned to the client.

Select a provider under **Models**, then use the **Refresh models** icon. For OpenCode
and compatible Pi versions this first refreshes the CLI's model cache, then
forces Paseo provider discovery for the host's default catalog. Codex uses Paseo's
provider refresh directly. The resulting catalog updates the normal model
picker and the searchable list on the page, shown eight models per page.
Workspace configuration can produce a different catalog for that workspace.
Cache failures are reported without preventing Paseo discovery. This does not add hardcoded models or
change the selected model. A model's presence in the catalog does not guarantee
account access for an inference request. Reload the client and server entries
together: host-level model refresh omits the previously required workspace ID.

### Adding a usage provider

1. Add its ID, display name, and icon to `shared/providers.ts`.
2. Implement `ProviderAdapter` in `server/providers/<provider>.ts`: quota reader,
   history reader, and safe error descriptions. Put pure parsing in `shared/`.
3. Register the adapter in `server/providers/index.ts`. Type checking requires
   an adapter for every registered provider.
4. Add parsing and I/O tests, run `npm run check`, and reload `essentials`.

Header buttons, RPC provider validation, quota caching, and history collection
use the registry automatically. Adding a provider requires no new provider
conditionals in those flows. Moving pure functions to `shared/` changes source
organization, not where those functions execute; server readers still perform
the account and filesystem work.

## Provider usage

Two workspace header buttons separate account quota from workspace usage:

- **Provider usage** shows the selected provider's lowest remaining quota
  percentage, quota bars, and relative reset times, with a link to token history.
  Logo-only buttons in a slim left sidebar switch providers; the selected
  provider's name appears with its quota details.
- **Workspace usage** shows the selected workspace's tokens by model and the
  latest five sessions for the selected provider and period. Expand a session to
  see each model's input/output and exact token counts.

**Open usage tab** opens a **Usage history** tab beside the workspace's other
tabs. The quota popup selects the current provider and seven days across the
host; the workspace popup preserves its selected period and workspace scope.
Each workspace tab keeps its own provider, period, and scope selection.
The tab contains one filter toolbar and token summary, followed by activity,
model breakdowns, and every matching session in pages of 20 within the retained
90-day history. The selected scope applies to the summary, activity, models,
session counts, and session pages. Totals and model counts include every matching
session, regardless of the displayed page. The tab stays attached to its owning
workspace. Changing host, workspace, provider, period, or scope resets pagination
and expanded rows. Select model or session rows for exact counts. Narrow tabs
use stacked charts and fewer numeric columns.

Token charts live in the workspace tab: 7 days displays daily totals, 30 days
displays 7-day periods, and 90 days displays 30-day periods. The 30-day view
includes an explicitly labeled two-day remainder followed by four full weeks;
no days are discarded. Intervals end on the current UTC day, including today's
usage. Header popovers render plain content; Paseo owns their scrolling.

Quota provider selection is remembered per workspace until the plugin or host
connection reloads. Quota data is refreshed and cached for one minute across
workspaces and clients. Refresh respects the quota and history caches. Failed
reads show an em dash or an unavailable message, never a fabricated zero.

The Codex quota popover also shows **Banked resets** and **Use reset**. A host
dialog asks for confirmation before spending one credit on the connected Codex
account; this affects eligible quota across that account's sessions. Cancel or
dismiss leaves the credits untouched. The control is disabled when the count is
zero or unavailable, except when retrying an unresolved request.

Redemption uses the documented `account/rateLimitResetCredit/consume` method.
Before preparing a new attempt, the daemon fetches fresh reset details and
selects the soonest-expiring available Codex reset, skipping expired credits.
Credits without an expiry come last; equal expiries prefer the oldest grant.
The preference applies to the details Codex returns, which may be truncated.
When no eligible details are reported (including count-only CLI responses),
Codex selects the credit. Malformed details or a failed read stop preparation
without spending a credit.

The daemon generates a UUID and shares an unresolved attempt across clients.
The client retains that UUID and selected credit across popover closes and uncertain responses;
retries reuse it, including after a server plugin reload. Duplicate confirmations
are deduplicated and automatic redemption retries are disabled. After a confirmed
response, quota and reset count are fetched again, bypassing the minute cache.
Success, already-applied resets, no eligible quota, and no remaining credits have
distinct feedback. If the CLI does not report reset credits, quota still works
and the reset control shows that the feature is unavailable. Reset redemption
requires a Codex CLI version supporting the documented account method.

On compact/mobile layouts, Paseo shows an icon and opens the details as a sheet.
Paseo may put the button in its overflow menu when the header is crowded.

## Requirements

- Paseo daemon **and app** 0.9.2 or later; Node 22.13+ for OpenCode SQLite history.
- Codex CLI on the daemon's PATH, signed in with ChatGPT. API-key billing does
  not provide these ChatGPT subscription windows. Set `PASEO_USAGE_CODEX_BIN`
  in the daemon environment for a custom executable path.
- OpenCode Go configured with `/connect` on the daemon machine, or
  `OPENCODE_GO_API_KEY` set in the daemon environment.

The Go reader checks the environment first, then reads only the `opencode-go`
API entry in `$XDG_DATA_HOME/opencode/auth.json` (default:
`~/.local/share/opencode/auth.json`). `OPENCODE_GO_AUTH_FILE` overrides the path.
Keys are never returned to the client or written to plugin logs. Do not put keys
in source, package files, or command history. Environment variables must reach
the daemon; exporting them in an unrelated terminal does not configure it.

Codex uses a short-lived `codex app-server` process and the documented
`account/rateLimits/read` method. It starts no thread or model turn. The CLI uses
its own account configuration and may refresh its authentication. OpenCode Go
uses `https://opencode.ai/zen/go/v1/usage`; this endpoint is present in the
upstream implementation but is not covered by the public Console CSV export API.
If its response changes, usage is shown as unavailable until the reader is updated.

## Install from this checkout

```bash
# From the paseo-plugins checkout:
cd essentials
npm ci --ignore-scripts
npm run check
paseo plugin install "$PWD"
paseo plugin ls
```

Enable plugins in Paseo's
**Settings → Plugins** before installing. Plugins are trusted, unsandboxed code
running with the daemon user's access. Installation is per daemon, and the
usage shown belongs to accounts on that daemon.

After editing, run `npm run check`, then
`paseo plugin reload essentials`. Do not restart the daemon to reload
this plugin. Use `paseo plugin logs essentials` for load errors.

Open a workspace to see the usage button. New workspaces are discovered within one
minute; **Show provider usage** in the Command Center adds it immediately.
**Show workspace usage history** opens the history tab for the current workspace.
For live verification, switch providers in the popover with real accounts, an unavailable
account, a narrow/mobile layout, and light/dark themes.

## Stored history

Normalized history is stored at
`$PASEO_HOME/storage/provider-usage/history.json`, with `PASEO_HOME` defaulting
to `$HOME/.paseo`. Writes are atomic, files are private to the daemon user, and
retention is 90 days. Prompts, responses, and credentials are never stored.
The cache contains only normalized usage, session/model identifiers, directory,
timestamps, and recorded cost estimates. The workspace popup and history tab share this
store; storage paths and cache internals are not displayed. Source logs are
rescanned at most every five minutes while usage views request history.

Codex history comes from `$CODEX_HOME/sessions` and `archived_sessions`, with
`CODEX_HOME` defaulting to `$HOME/.codex`. OpenCode history comes from
`$XDG_DATA_HOME/opencode/opencode.db`, where `XDG_DATA_HOME` defaults to
`$HOME/.local/share`. Set `OPENCODE_USAGE_DB` for a custom database path.
The database is opened read-only; OpenCode v1 and v2 message tables are supported.

Pi history is also collected from `~/.pi/agent/sessions`, including sessions
started through Paseo. `PI_CODING_AGENT_DIR` changes the Pi agent directory;
`PI_CODING_AGENT_SESSION_DIR` overrides the session directory. Set
`PI_USAGE_SESSION_DIR` in the daemon environment to override the collector's
session directory, for example when Pi uses a custom `--session-dir` or
provider-specific environment. These paths are read-only. Pi is scanned once
per history refresh and shared by both provider views.

Each Pi assistant message is attributed by its recorded provider: `openai-codex`
contributes to Codex, and `opencode-go` contributes to OpenCode Go. Provider/model
switches within a session are preserved; `openai` API and `opencode` Zen usage
are excluded. Pi session IDs have a `pi:` prefix to keep them separate from
native harness sessions, including in older caches. Copied files and repeated
entries are deduplicated. In forked sessions, entries older than the fork's
header timestamp are excluded as inherited usage; missing parent usage cannot
be reconstructed. All recorded branches are counted, not just the active branch.
Explicit Pi usage records and built-in compaction/branch-summary usage are
included when recorded. Extension-generated summaries are excluded because
their provider/model cannot be established from those records.

Pi history needs no Codex CLI or OpenCode installation. An absent native history
source is empty; a failed source produces a warning while other sources continue
updating and its previously stored history is retained. Quota lookup remains
separate: it uses the Codex CLI account and configured OpenCode Go key described
above, not Pi's authentication file. Quotas apply to Pi only when it uses that
same account. History totals combine local records by provider and do not
identify or filter individual billing accounts.

**All workspaces** covers all locally collected session directories on the
selected host, including worktrees and terminal-started sessions without an active
Paseo workspace. It does not combine hosts. Each session shows its recorded source
directory, with the full selectable path in expanded details; this is not a
workspace-name lookup. **This workspace** uses exact directory matching, without
including child directories or other worktrees. The workspace header popup always
uses this scope and shows the latest five sessions.
Both scopes are limited to the selected 7, 30, or 90 calendar days,
with UTC day boundaries. Model changes within a session retain separate totals.
Missing model identifiers, including older stored rows, appear as **Unknown model**.
Rescanning older rows replaces the entire day's snapshot so newly discovered
model information does not double-count legacy totals.
Missing/removed source logs and sessions on other hosts cannot be reconstructed.
Previously imported daily data remains until retention expires.

Reload the client and server plugin entries together for this scope contract.
Requests that omit scope remain workspace-scoped, but older servers cannot supply
the selected-scope model and session-count fields required by the new client.

Input totals include cache tokens; output totals include reasoning tokens.
Cache and reasoning counts are subsets, not additional tokens to add again.
Native Codex logs do not report dollar cost, so their cost is unavailable.
OpenCode's recorded model cost and Pi's `usage.cost.total` are imported and
displayed as **Estimated cost** in USD. These model-price estimates may differ
from your subscription bill. No prices are looked up or invented; missing or
invalid Pi estimates remain unavailable, and recorded zero estimates stay zero.
An aggregate with any unavailable cost also remains unavailable.
The first inherited token total in a forked Codex session is excluded.
Pi's input total includes cache reads and writes. Its output already includes
reasoning, so reasoning is never added again; older Pi versions may not record
a separate reasoning count. Reloading the plugin and refreshing history rescans
retained source logs, replacing previously cached Pi null costs with recorded
estimates without double-counting tokens. Deleted source logs cannot be backfilled.
Large scans fail with an explicit warning and retain previously stored data.

## Development checks

```bash
npm run check
npm run format
```

Tests use fake processes and HTTP responses; they never access real account
credentials. Live installation and visual verification are separate checks.
`node_modules/` stays local; commit the lockfile with source changes.

References: [Paseo header buttons](https://paseo.sh/docs/plugins/reference#header-buttons),
[Codex account API](https://learn.chatgpt.com/docs/app-server),
[OpenCode Go usage endpoint](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts).
