// Codex: global servers in $CODEX_HOME/config.toml (default ~/.codex),
// managed with `codex mcp add NAME -- CMD...`, `codex mcp remove NAME`, and
// read with `codex mcp get NAME --json`. Verified against codex-cli 0.158.0.
import { homedir } from "node:os";
import { join } from "node:path";
import { createRunner, type Runner } from "./exec.js";
import { CODEX_INSTRUCTIONS } from "./instructions.js";
import { SERVER_NAME, type HarnessAdapter, type HarnessState, type ServerLaunch } from "./types.js";

export function codexAdapter(options: { runner?: Runner; env?: NodeJS.ProcessEnv } = {}): HarnessAdapter {
  const env = options.env ?? process.env;
  const runner = options.runner ?? createRunner(env);
  const binary = "codex";
  const home = env.CODEX_HOME ?? join(homedir(), ".codex");
  const configPath = join(home, "config.toml");

  return {
    id: "codex",
    displayName: "Codex",
    binary,
    // Codex gives MCP server instructions little weight, so without this it
    // acknowledges "remember that..." instead of calling memory_store.
    instructions: { path: join(home, "AGENTS.md"), body: CODEX_INSTRUCTIONS },

    async inspect(): Promise<HarnessState> {
      const version = await runner(binary, ["--version"]);
      const state: HarnessState = { installed: version.code === 0, configPath };
      if (!state.installed) return state;
      state.version = version.stdout.trim().split(/\s+/).pop();

      const got = await runner(binary, ["mcp", "get", SERVER_NAME, "--json"]);
      if (got.code !== 0) {
        if (/No MCP server named/i.test(got.stderr + got.stdout)) return state;
        throw new Error(`codex mcp get failed: ${(got.stderr || got.stdout).trim()}`);
      }
      const transport = (JSON.parse(got.stdout) as { transport?: { command?: unknown; args?: unknown; env?: unknown } }).transport;
      if (transport && typeof transport.command === "string") {
        state.entry = {
          command: transport.command,
          args: Array.isArray(transport.args) ? transport.args.map(String) : [],
          ...(transport.env && typeof transport.env === "object" && Object.keys(transport.env).length > 0
            ? { env: transport.env as Record<string, string> }
            : {}),
        };
      }
      return state;
    },

    addSteps(launch: ServerLaunch) {
      const envFlags = Object.entries(launch.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      return [{ command: binary, args: ["mcp", "add", SERVER_NAME, ...envFlags, "--", launch.command, ...launch.args] }];
    },

    removeSteps() {
      return [{ command: binary, args: ["mcp", "remove", SERVER_NAME] }];
    },
  };
}
