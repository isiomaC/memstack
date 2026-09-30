// Claude Code: user-scope servers, managed with `claude mcp add-json -s user`
// and `claude mcp remove -s user`, stored under top-level `mcpServers` in
// $CLAUDE_CONFIG_DIR/.claude.json (default ~/.claude.json). Verified against
// Claude Code 2.1.285 and https://code.claude.com/docs/en/mcp.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRunner, type Runner } from "./exec.js";
import { SERVER_NAME, type HarnessAdapter, type HarnessState, type ServerLaunch } from "./types.js";

export function claudeCodeAdapter(options: { runner?: Runner; env?: NodeJS.ProcessEnv } = {}): HarnessAdapter {
  const env = options.env ?? process.env;
  const runner = options.runner ?? createRunner(env);
  const binary = "claude";
  const configPath = join(env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");

  return {
    id: "claude-code",
    displayName: "Claude Code",
    binary,

    async inspect(): Promise<HarnessState> {
      const version = await runner(binary, ["--version"]);
      const state: HarnessState = { installed: version.code === 0, configPath };
      if (state.installed) state.version = version.stdout.trim().split(/\s+/)[0];
      state.entry = readEntry(configPath);
      return state;
    },

    addSteps(launch: ServerLaunch) {
      const json = JSON.stringify({ type: "stdio", command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) });
      return [{ command: binary, args: ["mcp", "add-json", "-s", "user", SERVER_NAME, json] }];
    },

    removeSteps() {
      return [{ command: binary, args: ["mcp", "remove", "-s", "user", SERVER_NAME] }];
    },
  };
}

// Read-only: `claude mcp get` would also start the server to health-check it.
function readEntry(configPath: string): ServerLaunch | undefined {
  if (!existsSync(configPath)) return undefined;
  let config: { mcpServers?: Record<string, { command?: unknown; args?: unknown; env?: unknown }> };
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${configPath}: ${(error as Error).message}`);
  }
  const entry = config.mcpServers?.[SERVER_NAME];
  if (!entry || typeof entry.command !== "string") return undefined;
  return {
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    ...(entry.env && typeof entry.env === "object" ? { env: entry.env as Record<string, string> } : {}),
  };
}
