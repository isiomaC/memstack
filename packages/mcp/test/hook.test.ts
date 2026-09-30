import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStorageAdapter, projectNamespace } from "@memstack/core";
import { resolveProject } from "@memstack/config-env";

const distCli = new URL("../dist/cli.js", import.meta.url).pathname;

describe.skipIf(!existsSync(distCli))("memstack-mcp hook session-start", () => {
  let dir: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "memstack-hook-")));
    repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    const home = join(dir, "home");
    mkdirSync(home);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ version: 1, llm: { provider: "openai-compatible", apiKey: "sk-test", baseURL: "http://127.0.0.1:9" }, storage: { type: "disk", path: join(home, "data") } }),
      { mode: 0o600 },
    );
    env = { PATH: process.env.PATH ?? "", MEMSTACK_HOME: home };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runHook = (input: object, extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [distCli, "hook", "session-start", "--harness", "codex"], {
      input: JSON.stringify(input),
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 15_000,
    });

  async function seed(actorId: string, content: string, importance = 0.5) {
    const storage = new DiskStorageAdapter({ storageDir: join(dir, "home", "data") });
    await storage.initialize();
    await storage.store({ actorId, content, importance, memoryType: "instruction" });
  }

  it("prints the project's most important memories, project and global", async () => {
    const project = resolveProject(repo);
    await seed(projectNamespace(project.id), "Validate request bodies with Zod", 0.9);
    await seed("global", "Prefer small pull requests", 0.6);
    await seed(projectNamespace("other-project"), "Unrelated secret plan", 1);

    const result = runHook({ cwd: join(repo), session_id: "s1", source: "startup", hook_event_name: "SessionStart" });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toMatch(new RegExp(`^MemStack project memory \\(project ${project.id}\\), most important first\\.`));
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^- \[mem_\S+\] Validate request bodies with Zod \(instruction, project\)$/),
      expect.stringMatching(/^- \[mem_\S+\] Prefer small pull requests \(instruction, global\)$/),
    ]);
    expect(result.stdout).not.toContain("Unrelated secret plan");
  });

  it("prefers CLAUDE_PROJECT_DIR over the input cwd", async () => {
    await seed(projectNamespace(resolveProject(repo).id), "Uses Hono");
    const result = runHook({ cwd: dir }, { CLAUDE_PROJECT_DIR: repo });
    expect(result.stdout).toContain("Uses Hono");
  });

  it("prints nothing for a project without memories", () => {
    const result = runHook({ cwd: repo });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 with nothing on stdout when configuration is broken", () => {
    writeFileSync(join(dir, "home", "config.json"), "not json");
    const result = runHook({ cwd: repo });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("memstack hook:");
  });

  it("tolerates missing or malformed input", async () => {
    await seed(projectNamespace(resolveProject(repo).id), "Uses Hono");
    const result = spawnSync(process.execPath, [distCli, "hook", "session-start"], { input: "garbage", cwd: repo, env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Uses Hono");
  });

  it("caps output well under the harnesses' context limits", async () => {
    const id = projectNamespace(resolveProject(repo).id);
    for (let i = 0; i < 30; i++) await seed(id, `Rule ${i}: ${"x".repeat(900)}`);
    expect(runHook({ cwd: repo }).stdout.length).toBeLessThan(8000);
  });
});
