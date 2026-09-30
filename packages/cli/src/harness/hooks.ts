// MemStack's session-start hook entry in a harness's hooks file. Claude Code
// ($CLAUDE_CONFIG_DIR/settings.json, default ~/.claude/settings.json) and
// Codex ($CODEX_HOME/hooks.json) share the shape
// { hooks: { SessionStart: [{ matcher, hooks: [{ type, command, ... }] }] } }.
// Only MemStack's own entry is ever added, replaced, or removed.
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic, backupFile } from "./files.js";
import type { HarnessId, ServerLaunch } from "./types.js";

export interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
  statusMessage: string;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: { command?: unknown }[];
  [key: string]: unknown;
}

type HooksFile = { hooks?: Record<string, MatcherGroup[] | undefined> & Record<string, unknown> } & Record<string, unknown>;

const OURS = /\bhook session-start --harness (claude-code|codex)\b/;

/** The hook command a harness runs: the installed server's `hook session-start` subcommand. */
export function sessionStartHook(launch: ServerLaunch, harness: HarnessId): HookCommand {
  // The launch runs the server; the hook runs the same binary and script with the hook subcommand.
  const script = launch.args[0]?.endsWith(".js") ? [launch.args[0]] : [];
  const parts = [launch.command, ...script].map(shellQuote);
  return {
    type: "command",
    command: `${parts.join(" ")} hook session-start --harness ${harness}`,
    timeout: 10,
    statusMessage: "Loading MemStack project memory",
  };
}

/** MemStack's current hook command in the file, or null. Throws if the file is not valid JSON. */
export function readHook(path: string): HookCommand | null {
  const file = read(path);
  for (const group of file?.hooks?.SessionStart ?? []) {
    for (const hook of group.hooks ?? []) {
      if (typeof hook.command === "string" && OURS.test(hook.command)) return hook as HookCommand;
    }
  }
  return null;
}

/** Adds or replaces MemStack's entry. Returns false when it is already exactly this hook. */
export function upsertHook(path: string, hook: HookCommand, matcher: string, backupDir: string): boolean {
  const file = read(path) ?? {};
  const current = readHook(path);
  if (current && JSON.stringify(current) === JSON.stringify(hook) && ourGroups(file).every((g) => g.matcher === matcher)) return false;

  const hooks = (file.hooks ??= {} as NonNullable<HooksFile["hooks"]>);
  hooks.SessionStart = [...withoutOurs(hooks.SessionStart ?? []), { matcher, hooks: [hook] }];
  save(path, file, backupDir);
  return true;
}

/** Removes MemStack's entry, and the file when nothing else is left in it. Returns false when absent. */
export function removeHook(path: string, backupDir: string): boolean {
  const file = read(path);
  if (!file || !readHook(path)) return false;
  const remaining = withoutOurs(file.hooks!.SessionStart ?? []);
  if (remaining.length > 0) file.hooks!.SessionStart = remaining;
  else delete file.hooks!.SessionStart;
  if (Object.keys(file.hooks!).length === 0) delete file.hooks;
  save(path, file, backupDir);
  return true;
}

function ourGroups(file: HooksFile): MatcherGroup[] {
  return (file.hooks?.SessionStart ?? []).filter((g) => (g.hooks ?? []).some((h) => typeof h.command === "string" && OURS.test(h.command)));
}

// Drops MemStack's hooks, keeping other hooks that share a matcher group.
function withoutOurs(groups: MatcherGroup[]): MatcherGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !(typeof h.command === "string" && OURS.test(h.command))) }))
    .filter((g, i) => g.hooks.length > 0 || (groups[i].hooks ?? []).length === 0);
}

function read(path: string): HooksFile | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    return parsed as HooksFile;
  } catch (error) {
    throw new Error(`${path} is not valid JSON, so MemStack left it unchanged: ${(error as Error).message}`);
  }
}

// Keeps the file's own indentation and trailing newline, so removing the
// hook restores a user's file byte for byte.
function save(path: string, file: HooksFile, backupDir: string): void {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (previous !== null) backupFile(path, backupDir);
  const indent = previous?.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  const newline = previous === null || previous.endsWith("\n") ? "\n" : "";
  writeFileAtomic(path, Object.keys(file).length === 0 ? null : `${JSON.stringify(file, null, indent)}${newline}`);
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
