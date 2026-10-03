// A marked block of agent instructions in a harness's global instruction file
// (Codex: $CODEX_HOME/AGENTS.md). Only the text between the markers is ever
// touched; the rest of the file is kept byte for byte.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { backupFile, writeFileAtomic } from "./files.js";

const BEGIN = "<!-- memstack:begin";
const END = "<!-- memstack:end -->";
const BLOCK_PATTERN = /\n?<!-- memstack:begin[^\n]*-->\n[\s\S]*?<!-- memstack:end -->\n?/;

export const CODEX_INSTRUCTIONS = [
  "## Project memory (MemStack)",
  "",
  "When the user asks you to remember something, save it with the memstack `memory_store` tool. Do not only acknowledge it, and do not write it into project files unless the user asks for a file change.",
  "At the start of a task, and before answering questions about this project's conventions, decisions, or the user's preferences, check `memory_retrieve`: it holds what earlier sessions, in Codex or other agents, were told to remember.",
].join("\n");

export function renderBlock(body: string, harness: string): string {
  return `${BEGIN} (managed by \`memstack connect ${harness}\`; removed by \`memstack disconnect ${harness}\`) -->\n${body}\n${END}\n`;
}

/** The managed block currently in the file, or null. */
export function readBlock(path: string): string | null {
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(BLOCK_PATTERN);
  return match ? match[0].replace(/^\n/, "") : null;
}

/**
 * Adds or replaces the managed block. Returns false when the file already
 * holds exactly this block. The previous file is copied to `backupDir` first.
 */
export function upsertBlock(path: string, block: string, backupDir: string): boolean {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current !== null && readBlock(path) === block) return false;

  let next: string;
  if (current === null || current.trim() === "") next = block;
  else if (BLOCK_PATTERN.test(current)) next = current.replace(BLOCK_PATTERN, (m) => `${m.startsWith("\n") ? "\n" : ""}${block}`);
  else next = `${current}${current.endsWith("\n") ? "" : "\n"}\n${block}`;

  write(path, next, current, backupDir);
  return true;
}

/** Removes the managed block, deleting the file if nothing else was in it. Returns false when absent. */
export function removeBlock(path: string, backupDir: string): boolean {
  if (!existsSync(path)) return false;
  const current = readFileSync(path, "utf8");
  if (!BLOCK_PATTERN.test(current)) return false;
  // The block and the blank-line separator added before it.
  const next = current.replace(BLOCK_PATTERN, "");
  if (next.trim() === "") {
    backupFile(path, backupDir);
    rmSync(path);
  } else {
    write(path, next, current, backupDir);
  }
  return true;
}

function write(path: string, content: string, previous: string | null, backupDir: string): void {
  if (previous !== null) backupFile(path, backupDir);
  writeFileAtomic(path, content);
}
