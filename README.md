# Paseo Plugins

Plugins for [Paseo](https://paseo.sh), installed independently on each daemon.

## Available plugins

| Plugin                                   | Features                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Paseo Essentials](essentials/README.md) | Codex and OpenCode Go subscription limits, token history including Pi sessions, workspace usage, and CLI/model maintenance. |

## Install Paseo Essentials

Use Paseo **0.9.2 or later** on both the daemon and app. For OpenCode SQLite
history, the daemon needs Node **22.13 or later**.

1. On the target daemon, enable **Settings → Plugins → Enable plugins**.
   Plugins run trusted, unsandboxed code with the daemon user's access.
2. Clone this repository and install the plugin on that daemon's machine:

   ```bash
   git clone https://github.com/josephjs1dev/paseo-plugins.git
   cd paseo-plugins/essentials
   paseo plugin install "$PWD"
   paseo plugin ls
   ```

   If you already have a checkout, run the last two commands from `essentials/`.
   Paseo supplies the runtime libraries; npm setup is only needed for development.

3. Confirm `essentials` shows **running**, then select that host in Paseo.
   Open a workspace for **Provider usage** and **Workspace usage**, or open
   **CLIs & Models (hostname)** from the sidebar.

Quota lookup uses accounts configured on the daemon: sign in to Codex with
ChatGPT, or connect OpenCode Go with `/connect`. See the
[Essentials README](essentials/README.md) for features and requirements.

## Update or troubleshoot

From the repository checkout on the daemon machine:

```bash
git pull
paseo plugin reload essentials
paseo plugin ls
paseo plugin logs essentials
```

Keep the checkout at its installed path. Installation is per daemon; repeat it
for each host you use. Reload the plugin after source updates.

For contributing, see the [development guidelines](essentials/README.md#development)
and [AGENTS.md](AGENTS.md). See the [Paseo plugin guide](https://paseo.sh/docs/plugins)
for installation and management details.
