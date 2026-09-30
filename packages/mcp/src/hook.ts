// Session-start hook: prints the project's most important
// memories so a new Claude Code or Codex session starts knowing them, even
// if the model never calls memory_retrieve. It makes no LLM call and never
// blocks a session: on any error it prints nothing and exits 0.
import { HarnessMemory, InMemoryStorageAdapter, GLOBAL_NAMESPACE, defaultRecallNamespaces } from "@memstack/core";
import type { Memory } from "@memstack/core";
import { loadConfig, resolveProject } from "@memstack/config-env";

/** Characters of memory text a hook prints, well under Claude Code's 10,000 and Codex's ~2,500-token limits. */
export const HOOK_MAX_CHARS = 6000;
const HOOK_LIMIT = 15;

export interface HookInput {
  cwd?: string;
  session_id?: string;
  source?: string;
}

/** The context a session starts with, or an empty string when the project has no memories. */
export async function sessionStartContext(input: HookInput, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const cwd = env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const project = resolveProject(cwd);
  const { config } = await loadConfig();
  const storage = config.storage ?? new InMemoryStorageAdapter();
  try {
    const memory = new HarnessMemory({ storage, llm: config.llm, autoTags: false });
    await memory.adoptProjects(project.previousIds, project.id);
    const { hits } = await memory.recall({
      namespaces: defaultRecallNamespaces(project.id),
      limit: HOOK_LIMIT,
      maxChars: HOOK_MAX_CHARS,
    });
    if (hits.length === 0) return "";
    return [
      `MemStack project memory (project ${project.id}), most important first. Follow these unless the user says otherwise; use memory_retrieve for more and memory_store to save new facts.`,
      ...hits.map(({ memory: m }) => formatLine(m)),
    ].join("\n");
  } finally {
    await storage.close();
  }
}

/** Runs the hook: reads JSON input from stdin, prints plain-text context. Always exits 0. */
export async function runSessionStartHook(): Promise<void> {
  try {
    const input = parseInput(await readStdin());
    const context = await sessionStartContext(input);
    if (context) process.stdout.write(`${context}\n`);
  } catch (error) {
    process.stderr.write(`memstack hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function formatLine(m: Memory): string {
  const scope = m.actorId === GLOBAL_NAMESPACE ? "global" : "project";
  return `- [${m.id}] ${m.content} (${m.memoryType}, ${scope})`;
}

function parseInput(raw: string): HookInput {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as HookInput) : {};
  } catch {
    return {};
  }
}

// Harnesses write the input and close stdin; don't wait forever if one doesn't.
function readStdin(timeoutMs = 2000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
