# Paseo Plugins

Independently installable plugins for [Paseo](https://paseo.sh), the app for
running AI coding agents on your own machines. These plugins help you understand
usage, maintain coding CLIs, and coordinate agents and workspaces.

Each plugin has its own directory, manifest, dependencies, and checks. Use either
or both; plugins are installed per daemon and available to its connected clients.

### [Essentials](essentials/README.md)

- View ChatGPT/Codex, Claude, and OpenCode Go subscription limits and reset times.
- Explore token history from Codex, Claude Code, Pi, and OpenCode, with daily
  charts and breakdowns by workspace, model, and session.
- Compare workspace usage with usage across the daemon host.
- Manage Codex, Claude Code, OpenCode, and Pi updates and model catalogs in Harnesses.
- View and use banked Codex resets when supported by the connected account and CLI.

The [Essentials README](essentials/README.md) covers requirements, GUI/CLI
installation, and development.

### [Conductor](conductor/README.md)

- Find pending questions, permission requests, failures, and manual reminders in
  one attention queue.
- Answer supported requests directly, or open the agent for its native controls.
- Filter and search agents, snooze items, and move through the queue with **Next item**.
- Follow parent and child agents, inspect recorded turn outcomes, and navigate
  back to their workspaces.
- Review recent response actions and archive eligible inactive agents.
- Follow agent-managed concerts, task progress, blockers, and reported results
  in the Concerts section. Agents create and update concerts through commands.

The [Conductor README](conductor/README.md) covers requirements, GUI/CLI
installation, and development.
