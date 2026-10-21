import { homedir } from "node:os";
import { join } from "node:path";

/** Environment and home directory used to find harness logs on this host. */
export interface HarnessPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

function environment(options: HarnessPathOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function home(options: HarnessPathOptions): string {
  return options.home ?? homedir();
}

function expandHome(path: string, homeDirectory: string): string {
  if (path === "~") {
    return homeDirectory;
  }

  return path.startsWith("~/") ? join(homeDirectory, path.slice(2)) : path;
}

/** Codex keeps active and archived rollout logs below these two directories. */
export function codexSessionRoots(
  options: HarnessPathOptions = {},
): readonly string[] {
  const root = environment(options).CODEX_HOME ?? join(home(options), ".codex");

  return [join(root, "sessions"), join(root, "archived_sessions")];
}

/** Claude Code writes one transcript per session below its projects directory. */
export function claudeProjectsRoot(options: HarnessPathOptions = {}): string {
  const root =
    environment(options).CLAUDE_CONFIG_DIR ?? join(home(options), ".claude");

  return join(root, "projects");
}

/** Pi stores session transcripts below its agent directory by default. */
export function piSessionsRoot(options: HarnessPathOptions = {}): string {
  const env = environment(options);
  const homeDirectory = home(options);
  const agentDirectory = expandHome(
    env.PI_CODING_AGENT_DIR ?? join(homeDirectory, ".pi", "agent"),
    homeDirectory,
  );
  const configured =
    env.PI_USAGE_SESSION_DIR ??
    env.PI_CODING_AGENT_SESSION_DIR ??
    join(agentDirectory, "sessions");

  return expandHome(configured, homeDirectory);
}

/** OpenCode keeps messages in one SQLite database for every model provider. */
export function opencodeDatabasePath(options: HarnessPathOptions = {}): string {
  const dataHome =
    environment(options).XDG_DATA_HOME ??
    join(home(options), ".local", "share");

  return join(dataHome, "opencode", "opencode.db");
}
