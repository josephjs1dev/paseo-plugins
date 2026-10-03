# Paseo Essentials

Usage tracking and CLI/model maintenance for Paseo, covering Codex, OpenCode Go,
and token history from Pi sessions.

## Features

- **Provider usage:** subscription quota and reset times for Codex and OpenCode Go.
  Codex also shows credit balance and banked resets when supported; **Use reset**
  asks for confirmation before consuming a banked reset.
- **Workspace usage:** token totals by model and recent sessions for the current
  workspace.
- **Usage history:** activity charts, model breakdowns, session details, and
  recorded cost estimates across this workspace or all local workspaces on the
  selected host. Browse 7 or 30 days; history is retained for 90 days. Includes
  native Codex/OpenCode logs and Pi's `openai-codex` and `opencode-go` sessions.
- **CLIs & Models (hostname):** check and apply supported Codex, OpenCode, and Pi
  CLI updates, and refresh the host's model catalog. Available from the sidebar
  and Command Center without an open workspace.

History is collected locally on each daemon. The normalized history cache stores
usage metadata without prompts, responses, or credentials. Missing quota or cost
information is shown as unavailable. Recorded costs are estimates in USD.

## Requirements and installation

Follow the [installation guide](../README.md#install-paseo-essentials).
Requires Paseo daemon and app **0.9.2+**, and Node **22.13+** for OpenCode SQLite
history.

For quota lookup, configure accounts on the daemon machine:

- **Codex:** CLI on PATH, signed in with ChatGPT. Set `PASEO_USAGE_CODEX_BIN` for
  a custom executable. API-key billing does not provide subscription quota.
- **OpenCode Go:** connect with `/connect`, or set `OPENCODE_GO_API_KEY` in the
  daemon environment. Set `OPENCODE_GO_AUTH_FILE` for a custom auth file.

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
provider, register it in `shared/providers.ts`, implement its adapter in
`server/providers/`, and register it in `server/providers/index.ts`.

After validation, run `paseo plugin reload essentials` and inspect
`paseo plugin logs essentials`. Live verification is separate from automated
checks; exercise the changed feature on the intended host, including compact
layouts and light/dark themes for UI changes. Read [AGENTS.md](../AGENTS.md)
before contributing.
