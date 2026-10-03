# Paseo Plugins

A collection of Paseo plugins, with each plugin kept in its own directory and
installed independently.

## Plugins

| Plugin                                | What it provides                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Paseo Essentials](essentials/README.md) | Codex and OpenCode Go subscription limits, token history including Pi sessions, workspace usage views, and CLI/model maintenance. |

## Repository layout

```text
paseo-plugins/
  AGENTS.md                     # project guidance and local rule references
  CLAUDE.md -> AGENTS.md         # shared agent entrypoint
  .codex/rules/                 # security and TypeScript/frontend rules
  essentials/
    paseo-plugin.json           # plugin ID and supported Paseo version
    index.client.tsx            # Paseo app contributions
    index.server.ts             # daemon-side contributions
    client/                     # React Native UI
    server/                     # processes, provider adapters, and persistence
    shared/                     # runtime-neutral contracts and parsing
    tests/                      # client, server, and shared checks
    package.json
    package-lock.json
```

## Develop Paseo Essentials

From this repository's root:

```bash
cd essentials
npm ci --ignore-scripts
npm run check
```

`npm run check` runs TypeScript checking, ESLint, the Prettier check, and tests.
Use `npm run format` to format plugin files. Each plugin owns its package and
lockfile; run its commands inside that plugin's directory.

## Install and reload

Paseo Essentials requires Paseo 0.9.2 or later. With plugins enabled on the target
daemon, run from the plugin directory on that host:

```bash
paseo plugin install "$PWD"
paseo plugin ls
```

After editing and checking the plugin:

```bash
paseo plugin reload essentials
paseo plugin logs essentials
```

Installation is per daemon. See the [Essentials README](essentials/README.md)
for feature behavior, history sources, configuration, and verification guidance.
The [Paseo plugin quickstart](https://paseo.sh/docs/plugins) and
[plugin reference](https://paseo.sh/docs/plugins/reference) document the runtime.

## Add another plugin

Create a separate directory at the repository root, with its own unique manifest
ID, package, lockfile, README, and checks. Keep app code in `client/`, daemon code in
`server/`, and runtime-neutral contracts in `shared/`. Add the plugin to the table
above. Install and reload each plugin by its own ID.

## Agent guidance

Read [AGENTS.md](AGENTS.md) before making changes. This project includes nestkit's
security rules and TypeScript coding rules, including the frontend companion.
It relies on existing user-installed skills and has no project MCP server setup.
