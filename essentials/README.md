# Paseo Essentials

Usage tracking and CLI/model maintenance for Paseo. Usage is grouped by provider
(ChatGPT or OpenCode Go) and collected from the Codex, Pi, and OpenCode harnesses.

## Features

- **Provider usage:** subscription quota and reset times for ChatGPT and OpenCode Go.
  ChatGPT also shows Codex credit balance, banked resets, and their earliest upcoming
  expiry in your local timezone when available; **Use reset**
  asks for confirmation before consuming a banked reset.
- **Workspace usage:** token totals by model and recent sessions for the current
  workspace.
- **Usage history:** activity charts, model breakdowns, session details, and
  recorded cost estimates across this workspace or all local workspaces on the
  selected host. Browse 7 or 30 days; history is retained for 90 days. Includes
  native Codex/OpenCode logs and Pi's `openai-codex` and `opencode-go` sessions.
  Provider totals combine harnesses; session rows identify Codex, Pi, or OpenCode.
- **CLIs & Models (hostname):** check and apply supported Codex, OpenCode, and Pi
  CLI updates, and refresh the host's model catalog. Available from the sidebar
  and Command Center without an open workspace.

History is collected locally on each daemon. The normalized history cache stores
usage metadata without prompts, responses, or credentials. Missing quota or cost
information is shown as unavailable. Recorded costs are estimates in USD.

ChatGPT history from Codex and Pi also shows **Estimated credits** in the daily chart, summary,
model rows, and session details. Estimates use the recorded model, uncached
input, cached input, and output (including reasoning) at published Standard
credit rates checked on **2026-10-03**. This is a model-usage estimate; speed,
included plan allowances, discounts, and actual billing adjustments are excluded.
Unknown models, including `codex-auto-review`, remain unpriced. Combined estimates
show **partial** and the share of tokens priced when only some models have rates.
Known zero estimates remain zero; entirely unpriced usage shows **Unavailable**.
Existing model-aware cached history gets estimates without needing its source
logs again. Recorded USD costs remain separate, and credit estimates are derived
on read so a rate-card update does not overwrite recorded history.
See [OpenAI's Codex credit rates](https://learn.chatgpt.com/docs/pricing#token-rates).

## Requirements and installation

Follow the [installation guide](../README.md#install-paseo-essentials).
Requires Paseo daemon and app **0.9.2+**, and Node **22.13+** for OpenCode SQLite
history.

Usage history shows one vertical bar per UTC day for 7 or 30 days. Hovering,
keyboard focus, or tapping a bar shows that day's total; storage still retains
90 days. Codex history reads both plain `.jsonl` and compressed `.jsonl.zst`
logs from `CODEX_HOME/sessions` and `archived_sessions`, using the default
`~/.codex` when `CODEX_HOME` is unset. Reading compressed logs requires Node
22.15+ on the daemon; older runtimes report an incomplete scan instead of
silently skipping those files. Source logs are never decompressed on disk.
Codex scans process recent logs first and keep completed imports if a scan
limit or unreadable file prevents a full refresh. Unscanned history stays in
the 90-day cache, and the usage view reports that history may be incomplete.

Usage views show cached results immediately and refresh behind the current view.
The client keeps each host/workspace/provider/period/scope selection cached for
24 hours after closing it. Saved daemon history survives plugin reloads; a first
scan is awaited only when there is no saved history. Stale scans run in the
background at most every five minutes, with one shared scan across views. Refresh
forces a background check, and the open view polls briefly until it finishes.

After a recent successful scan, collectors select sessions updated within the
last day. After a longer gap or failed scan, the update window stretches back to
that collector's last successful checkpoint so usage is not skipped. Checkpoints
and scan warnings are tracked independently per harness. Each selected JSONL log
is still read for its full retained snapshot; OpenCode rereads every retained
message in a touched session, including when only an older message was updated.
These snapshots replace their previous daily totals, keeping unrelated cached
history and avoiding partial-day losses or double counting. Incomplete first
scans establish recent coverage separately and keep their older-backlog warning.

For quota lookup, configure accounts on the daemon machine:

- **ChatGPT:** Codex CLI on PATH, signed in with ChatGPT. Set `PASEO_USAGE_CODEX_BIN` for
  a custom executable. API-key billing does not provide subscription quota.
- **OpenCode Go:** connect with `/connect`, or set `OPENCODE_GO_API_KEY` in the
  daemon environment. Set `OPENCODE_GO_AUTH_FILE` for a custom auth file.

Existing version 1 history caches migrate automatically to version 2 at the same
location. Migration preserves cached records, identifies legacy Pi sessions, and
starts a full retained-window scan for each harness.

Pi history works without native Codex or OpenCode installations. Set
`PI_USAGE_SESSION_DIR` or `OPENCODE_USAGE_DB` in the daemon environment for
custom history paths. Quotas reflect the configured account; history combines
local provider records and does not filter by billing account.

## Development

From `essentials/`:

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` runs type checking, linting, formatting checks, and tests.
Use `npm run format` to format changes. Tests use temporary files and fake
processes/HTTP responses, without real credentials.

- `index.client.tsx` and `client/`: Paseo app contributions and React Native UI.
- `index.server.ts` and `server/`: daemon I/O, credentials, processes, and storage.
- `shared/`: runtime-neutral RPC contracts, parsing, and aggregation; no Node or
  UI APIs.
- `tests/`: shared logic and server integration tests.

Keep runtime boundaries intact, return cleanup functions from contributions,
and pin dependencies with changes to `package-lock.json`. To add a usage
harness collector, add its metadata in `shared/harnesses.ts`, implement a
`UsageCollector` in `server/collectors/`, and register it in
`server/collectors/index.ts`. Every collector returns the same validated
`HistoryCollection` containing provider- and harness-attributed rows. Quota lookup
is optional: Codex supplies ChatGPT limits, OpenCode supplies OpenCode Go limits,
and Pi collects history only. Each collector owns its source paths and account
I/O; pure source normalization stays in `shared/history-parsers.ts`. Provider metadata in `shared/providers.ts` describes
subscription groups, rather than history sources.

After validation, run `paseo plugin reload essentials` and inspect
`paseo plugin logs essentials`. Live verification is separate from automated
checks; exercise the changed feature on the intended host, including compact
layouts and light/dark themes for UI changes. Read [AGENTS.md](../AGENTS.md)
before contributing.
