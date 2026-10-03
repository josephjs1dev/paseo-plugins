# paseo-plugins

## Project context

paseo-plugins is a collection of independently installable Paseo plugins. The initial plugin, essentials, provides Codex and OpenCode Go subscription limits, token history including Pi sessions, workspace usage views, and CLI/model maintenance.

Each plugin lives in its own directory at the repository root, such as essentials/, with its own manifest, package, lockfile, and checks. Paseo Essentials uses separate TypeScript client and server runtime entries, React Native UI in client/, daemon I/O in server/, and runtime-neutral RPC contracts and parsing in shared/. Paseo supplies the SDK and host libraries at runtime. Installation and reload are per daemon and separate from repository setup.

## Always-on rules

Security rules apply to every change, regardless of language:

- [Security rules](.codex/rules/security.md)

## Language rules (load when relevant)

- **typescript** — read [.codex/rules/typescript/coding-styles.md](.codex/rules/typescript/coding-styles.md) when working in that language.

Open the relevant language rule file the first time you touch that language
in a session.

## Personas

Select a persona from the descriptions below before opening any persona file.
Load only the selected file, once per session; do not read both to decide.
Use SWE for implementation, debugging, tests, and code review. Use Team Leader
for team coordination, work allocation, and delivery planning, or when the user
explicitly requests it. For mixed tasks, choose the primary role; switch only
when the task changes or the user requests another role. Skip personas for
tasks that do not benefit from either role. A TODO-only file adds no guidance;
do not load the other persona as a fallback.

- SWE: [.codex/personas/swe.md](.codex/personas/swe.md)
- Team Leader: [.codex/personas/team_leader.md](.codex/personas/team_leader.md)

## Repository guide

Read [README.md](README.md) for the plugin catalog and installation workflow.
Before changing Essentials, read [its README](essentials/README.md).
For frontend work, also read
[Frontend Coding Styles](.codex/rules/typescript/frontend-styles.md).

Keep each plugin independently installable in its own root directory, with its
own manifest, package, lockfile, runtime entries, README, and validation scripts.
Preserve the client/server/shared runtime boundaries. Keep dependencies pinned
and update the plugin lockfile when dependencies change.

## Validation

For Essentials, run `npm run check` in `essentials/`.
It runs type checking, linting, formatting checks, and tests. Tests use temporary
files and fake processes/HTTP responses; they do not require real credentials.
Live installation, reload, and visual verification are separate actions.
Run `git diff --check` for changes across the repository.

## Canonical instructions

Edit `AGENTS.md` directly; it is the canonical project instruction file.

## Commit and push

After completing changes and relevant validation, summarize the result and ask
whether to commit and push. Offer Commit and push, Commit only, and Leave
uncommitted. Do not commit or push without authorization; reuse authorization
already given for the current changes. Keep unrelated changes out of the commit.
