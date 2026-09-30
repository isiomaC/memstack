// Finds the user's own install of memstack-mcp and their storage driver.
// MemStack never installs either (ADR 0001, D7): these checks only look.
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { StorageType } from "@memstack/config-env";
import type { ServerLaunch, HarnessId } from "./types.js";

/** Driver package each store loads, with the range MemStack supports. */
export const STORAGE_DRIVERS: Partial<Record<StorageType, { module: string; spec: string }>> = {
  sqlite: { module: "better-sqlite3", spec: "better-sqlite3@^11.10.0" },
  postgres: { module: "postgres", spec: "postgres@^3.4.9" },
  redis: { module: "ioredis", spec: "ioredis@^5.11.1" },
};

/** The command a user runs to install the MCP server and their driver. */
export function installCommand(storage: StorageType | undefined): string {
  const driver = storage ? STORAGE_DRIVERS[storage] : undefined;
  return `npm install -g @memstack/mcp${driver ? ` ${driver.spec}` : ""}`;
}

/** Resolved path of `memstack-mcp` on PATH, or null. */
export function findMemstackMcp(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = process.platform === "win32" ? ["memstack-mcp.cmd", "memstack-mcp"] : ["memstack-mcp"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
  }
  return null;
}

/**
 * Whether `module` can be loaded from where the script lives, walking up
 * node_modules directories the way Node resolves packages. A global npm
 * install finds drivers installed globally next to @memstack/mcp.
 */
export function canResolveFrom(scriptPath: string, module: string): boolean {
  let dir = dirname(scriptPath);
  for (;;) {
    if (existsSync(join(dir, "node_modules", module, "package.json"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * How a harness starts the server: the current Node binary running the
 * installed script by absolute path, so it works even when the harness is
 * launched without the user's shell PATH. No secrets go in the harness
 * config; the server reads ~/.memstack/config.json.
 */
export function harnessLaunch(mcpScript: string, harness: HarnessId): ServerLaunch {
  const isScript = /\.(c|m)?js$/.test(mcpScript);
  const args = ["--profile", "harness", "--harness", harness];
  return isScript ? { command: process.execPath, args: [mcpScript, ...args] } : { command: mcpScript, args };
}
