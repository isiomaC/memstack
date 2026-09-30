// Cross-harness demo, scripted: `memstack connect` registers the built MCP
// server with the real Claude Code and Codex CLIs (in throwaway config
// directories), then each harness's registered command is started the way
// the harness would start it. A memory stored through Claude Code's entry
// must be recalled through Codex's, and the reverse. Skipped unless both
// CLIs are installed and the packages are built.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { writeConfigFile } from "@memstack/config-env";

const cliDist = new URL("../dist/cli.js", import.meta.url).pathname;
const mcpDist = new URL("../../mcp/dist/cli.js", import.meta.url).pathname;
const hasCli = (name: string) => {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const ready = existsSync(cliDist) && existsSync(mcpDist) && hasCli("claude") && hasCli("codex");

type Launch = { command: string; args: string[] };

/** Starts a server the way a harness does and runs one tool call. */
function callTool(launch: Launch, cwd: string, env: NodeJS.ProcessEnv, name: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out: ${stderr}`));
    }, 20_000);
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (message.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/call", params: { name, arguments: args } });
        } else if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(message.result.content.map((c: { text: string }) => c.text).join("\n"));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
  });
}

describe.skipIf(!ready)("cross-harness memory through memstack connect", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  const memstack = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [cliDist, ...args], { cwd: repo, env, encoding: "utf8" }) };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "memstack-e2e-")));
    repo = join(root, "repo");
    const bin = join(root, "bin");
    for (const d of [repo, bin, join(root, "claude"), join(root, "codex")]) mkdirSync(d, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/demo.git"]);
    symlinkSync(mcpDist, join(bin, "memstack-mcp"));

    env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      MEMSTACK_HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
    };
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MEMSTACK_OPENAI_BASE_URL", "MEMSTACK_LLM_MODEL", "MEMSTACK_STORAGE", "CLAUDE_PROJECT_DIR"]) {
      delete env[key];
    }
    // Unreachable LLM: tagging fails fast and memories are stored untagged.
    writeConfigFile(
      { version: 1, llm: { provider: "openai-compatible", apiKey: "sk-test", baseURL: "http://127.0.0.1:9" }, storage: { type: "disk", path: join(root, "home", "data") } },
      join(root, "home", "config.json"),
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("connects both harnesses, idempotently", () => {
    const first = memstack("connect", "claude-code", "codex");
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain("✓ Connected Claude Code.");
    expect(first.out).toContain("✓ Connected Codex.");

    const again = memstack("connect", "claude-code", "codex");
    expect(again.out).toContain("Claude Code is already connected");
    expect(again.out).toContain("Codex is already connected");

    const status = memstack("status").out;
    expect(status).toMatch(/Claude Code:\s+connected\n/);
    expect(status).toMatch(/Codex:\s+connected\n/);
  }, 120_000);

  it("shares memory from Claude Code to Codex and back", async () => {
    const claudeEntry = JSON.parse(readFileSync(join(root, "claude", ".claude.json"), "utf8")).mcpServers.memstack as Launch;
    const codexEntry = JSON.parse(execFileSync("codex", ["mcp", "get", "memstack", "--json"], { env, encoding: "utf8" })).transport as Launch;
    // Claude Code tells the server the project via CLAUDE_PROJECT_DIR; Codex starts it in the project.
    const claudeEnv = { ...env, CLAUDE_PROJECT_DIR: repo };
    const subdir = join(repo, "src");
    mkdirSync(subdir, { recursive: true });

    expect(await callTool(claudeEntry, root, claudeEnv, "memory_store", { content: "This project uses Hono", tags: ["framework"] })).toMatch(/^Stored/);
    expect(await callTool(codexEntry, subdir, env, "memory_retrieve", { query: "Which framework does this project use?" })).toContain(
      "This project uses Hono (fact, project, from claude-code",
    );

    expect(await callTool(codexEntry, repo, env, "memory_store", { content: "Validation uses Zod", tags: ["validation"] })).toMatch(/^Stored/);
    expect(await callTool(claudeEntry, root, claudeEnv, "memory_retrieve", { query: "validation" })).toContain(
      "Validation uses Zod (fact, project, from codex",
    );

    const elsewhere = join(root, "other");
    mkdirSync(elsewhere, { recursive: true });
    expect(await callTool(codexEntry, elsewhere, env, "memory_retrieve", { query: "framework" })).toBe("No memories yet for this project.");
  }, 120_000);

  it("lists the project's memories and passes doctor", () => {
    const listed = memstack("memories");
    expect(listed.code, listed.out).toBe(0);
    expect(listed.out).toContain("This project uses Hono");
    expect(listed.out).toContain("Validation uses Zod");

    const doctor = memstack("doctor");
    expect(doctor.out).toContain("✓ Claude Code is connected");
    expect(doctor.out).toContain("✓ Codex is connected");
    expect(doctor.out).toContain("✓ MCP server starts and answers");
    expect(doctor.code, doctor.out).toBe(0);
  }, 120_000);

  it("keeps memories when the project gets its first commit, and when it is pinned", async () => {
    const codexEntry = JSON.parse(execFileSync("codex", ["mcp", "get", "memstack", "--json"], { env, encoding: "utf8" })).transport as Launch;
    const before = memstack("project").out;
    expect(before).toContain("git directory (no commits yet)");

    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    const afterCommit = memstack("project").out;
    expect(afterCommit).toContain("first commit");
    const committedId = afterCommit.match(/Project:\s+(\S+)/)![1];

    // The server adopts the memories from the pre-commit ID when it starts.
    expect(await callTool(codexEntry, repo, env, "memory_retrieve", { query: "framework" })).toContain("This project uses Hono");
    expect(await callTool(codexEntry, repo, env, "memory_stats", {})).toMatch(new RegExp(`^Project ${committedId} .*: 2 memories\\.`));

    const pinned = memstack("project", "pin", "acme-demo");
    expect(pinned.out).toContain(`memstack project merge ${committedId}`);
    expect(memstack("memories").out).toContain("No memories.");

    expect(memstack("project", "merge", committedId).out).toContain(`Moved 2 memories from ${committedId} to acme-demo.`);
    expect(await callTool(codexEntry, repo, env, "memory_retrieve", { query: "validation" })).toContain("Validation uses Zod");
  }, 120_000);

  it("disconnects reversibly and keeps memories", () => {
    const result = memstack("disconnect", "claude-code", "codex");
    expect(result.out).toContain("✓ Disconnected Claude Code. Your memories are kept.");
    expect(memstack("status").out).toMatch(/Claude Code:\s+not connected\n/);
    expect(memstack("memories").out).toContain("This project uses Hono");
  }, 120_000);
});
