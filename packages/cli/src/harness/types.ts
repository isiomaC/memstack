export type HarnessId = "claude-code" | "codex";

/** How a harness starts the MemStack MCP server. */
export interface ServerLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HarnessState {
  /** The harness CLI is on PATH. */
  installed: boolean;
  version?: string;
  /** Config file the harness keeps MCP servers in. */
  configPath: string;
  /** The `memstack` server entry, when one is configured. */
  entry?: ServerLaunch;
}

export interface CommandStep {
  command: string;
  args: string[];
}

export interface ConnectPlan {
  harness: HarnessId;
  /** Harness CLI commands that apply the change, in order. Empty when nothing changes. */
  steps: CommandStep[];
  /** Entry before the change, used to roll back. */
  previous?: ServerLaunch;
  /** Entry after the change; undefined for a disconnect. */
  target?: ServerLaunch;
  /** Instruction file change, when the harness has one and it is not skipped. */
  instructions?: { path: string; change: "add" | "update" | "remove" | "none" };
}

/**
 * One agent harness. Adapters change configuration only through the
 * harness's own `mcp` commands, never by editing its files, so they stay
 * correct when the harness changes its file format or rewrites the file.
 */
export interface HarnessAdapter {
  id: HarnessId;
  displayName: string;
  /** Harness CLI binary. */
  binary: string;
  inspect(): Promise<HarnessState>;
  addSteps(launch: ServerLaunch): CommandStep[];
  removeSteps(): CommandStep[];
  /** Global instruction file the harness always loads, when MemStack should add guidance to it. */
  instructions?: { path: string; body: string };
}

export const SERVER_NAME = "memstack";

export function sameLaunch(a: ServerLaunch | undefined, b: ServerLaunch | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
  );
}
