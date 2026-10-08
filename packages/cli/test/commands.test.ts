import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG_ROOT = new URL("..", import.meta.url).pathname;
const CLI_PATH = join(PKG_ROOT, "dist", "cli.js");

/** Minimal OpenAI-compatible chat/completions stand-in so `summarize`/`health`
 * can exercise the real LLM adapter's HTTP call without hitting the network. */
function startMockLLM(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "mock summary of memories" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

/** Spawned (not sync) — the CLI process talks to an HTTP server running in
 * *this* test process, so a blocking spawnSync would deadlock the event loop
 * the server needs in order to respond. */
function run(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out. args=${JSON.stringify(args)} stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

beforeAll(() => {
  execFileSync("pnpm", ["exec", "tsup", "src/cli.ts", "--format", "esm", "--clean"], {
    cwd: PKG_ROOT,
    stdio: "inherit",
  });
}, 30_000);

/** process.env without MemStack and LLM variables, so a developer's own setup can't leak in. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(MEMSTACK_|OPENAI_|ANTHROPIC_|SQLITE_PATH$|DATABASE_URL$|REDIS_URL$)/.test(key)),
  );
  return { ...env, ...extra };
}

describe("memstack CLI commands", () => {
  let mockLLM: { server: Server; baseURL: string };
  let dataDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    mockLLM = await startMockLLM();
    dataDir = mkdtempSync(join(tmpdir(), "memstack-cli-test-"));
    env = {
      ...cleanEnv(),
      MEMSTACK_HOME: dataDir,
      MEMSTACK_STORAGE: "disk",
      MEMSTACK_DIR: dataDir,
      MEMSTACK_EMBED_ON_STORE: "false",
      OPENAI_API_KEY: "sk-test",
      MEMSTACK_OPENAI_BASE_URL: mockLLM.baseURL,
    };
  }, 30_000);

  afterAll(() => {
    mockLLM?.server.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function runJSON(args: string[]) {
    const { status, stdout, stderr } = await run(args, env);
    expect(status, `stderr: ${stderr}`).toBe(0);
    return JSON.parse(stdout);
  }

  it("store creates a memory with the given actor and content", async () => {
    const memory = await runJSON(["store", "--actor", "alice", "--content", "likes tea", "--importance", "0.9", "--tags", "pref,drink"]);
    expect(memory.id).toMatch(/^mem_/);
    expect(memory.actorId).toBe("alice");
    expect(memory.content).toBe("likes tea");
    expect(memory.importance).toBe(0.9);
    expect(memory.tags).toEqual(["pref", "drink"]);
  });

  it("store fails with a clear error when --content is missing", async () => {
    const { status, stderr } = await run(["store", "--actor", "alice"], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain("--content is required");
  });

  it("retrieve returns previously stored memories for an actor", async () => {
    await runJSON(["store", "--actor", "bob", "--content", "first memory"]);
    await runJSON(["store", "--actor", "bob", "--content", "second memory"]);
    const memories = await runJSON(["retrieve", "--actor", "bob"]);
    expect(Array.isArray(memories)).toBe(true);
    expect(memories.length).toBeGreaterThanOrEqual(2);
    expect(memories.some((m: { content: string }) => m.content === "first memory")).toBe(true);
  });

  it("context compiles an LLM-ready context for an actor", async () => {
    await runJSON(["store", "--actor", "carol", "--content", "carol likes hiking"]);
    const context = await runJSON(["context", "--actor", "carol", "--max-tokens", "500"]);
    expect(context.systemPrompt).toBeTruthy();
    expect(Array.isArray(context.recentMemories)).toBe(true);
    expect(typeof context.tokenEstimate).toBe("number");
  });

  it("stats reports counts for a specific actor and overall", async () => {
    await runJSON(["store", "--actor", "dave", "--content", "dave's memory"]);
    const actorStats = await runJSON(["stats", "--actor", "dave"]);
    expect(actorStats.total).toBeGreaterThanOrEqual(1);

    const overallStats = await runJSON(["stats"]);
    expect(overallStats.total).toBeGreaterThanOrEqual(1);
  });

  it("delete removes a single memory by id", async () => {
    const memory = await runJSON(["store", "--actor", "erin", "--content", "to be deleted"]);
    const result = await runJSON(["delete", "--id", memory.id]);
    expect(result).toEqual({ deleted: true });

    const remaining = await runJSON(["retrieve", "--actor", "erin"]);
    expect(remaining.some((m: { id: string }) => m.id === memory.id)).toBe(false);
  });

  it("merge combines multiple memories into one", async () => {
    const a = await runJSON(["store", "--actor", "frank", "--content", "likes pizza"]);
    const b = await runJSON(["store", "--actor", "frank", "--content", "likes pasta"]);
    const merged = await runJSON(["merge", "--ids", `${a.id},${b.id}`]);
    expect(merged.id).toMatch(/^mem_/);
    expect(merged.actorId).toBe("frank");
  });

  it("merge fails with a clear error when fewer than 2 ids are given", async () => {
    const { status } = await run(["merge", "--ids", "mem_only_one"], env);
    expect(status).not.toBe(0);
  });

  it("prune --dry-run reports what would be pruned without deleting", async () => {
    await runJSON(["store", "--actor", "grace", "--content", "old memory", "--importance", "0.1"]);
    const before = await runJSON(["retrieve", "--actor", "grace"]);
    const dryRun = await runJSON(["prune", "--actor", "grace", "--type", "byImportance", "--min-importance", "0.5", "--dry-run"]);
    expect(Array.isArray(dryRun.wouldPrune)).toBe(true);
    expect(dryRun.count).toBeGreaterThanOrEqual(1);
    const after = await runJSON(["retrieve", "--actor", "grace"]);
    expect(after.length).toBe(before.length);
  });

  it("prune actually removes memories matching the strategy", async () => {
    await runJSON(["store", "--actor", "heidi", "--content", "low importance", "--importance", "0.05"]);
    const pruned = await runJSON(["prune", "--actor", "heidi", "--type", "byImportance", "--min-importance", "0.5"]);
    expect(pruned.count).toBeGreaterThanOrEqual(1);
    const remaining = await runJSON(["retrieve", "--actor", "heidi"]);
    expect(remaining.length).toBe(0);
  });

  it("purge deletes all memories for an actor", async () => {
    await runJSON(["store", "--actor", "ivan", "--content", "memory one"]);
    await runJSON(["store", "--actor", "ivan", "--content", "memory two"]);
    const purged = await runJSON(["purge", "--actor", "ivan"]);
    expect(purged).toBeGreaterThanOrEqual(2);
    const remaining = await runJSON(["retrieve", "--actor", "ivan"]);
    expect(remaining.length).toBe(0);
  });

  it("summarize compresses memories via the configured LLM", async () => {
    await runJSON(["store", "--actor", "judy", "--content", "judy memory one"]);
    await runJSON(["store", "--actor", "judy", "--content", "judy memory two"]);
    const result = await runJSON(["summarize", "--actor", "judy"]);
    expect(result.summary.content).toBe("mock summary of memories");
    expect(typeof result.deletedCount).toBe("number");
  });

  it("health checks storage, llm, and embedding connectivity", async () => {
    const health = await runJSON(["health"]);
    expect(health.storage).toBe(true);
    expect(health.llm).toBe(true);
    expect(health.embedding).toBe(false);
  });

  it("export returns a full snapshot and, with --out, writes it to a file", async () => {
    await runJSON(["store", "--actor", "kevin", "--content", "exportable memory"]);
    const snapshot = await runJSON(["export"]);
    expect(snapshot.version).toBe(1);
    expect(snapshot.memories.some((m: { actorId: string }) => m.actorId === "kevin")).toBe(true);

    const outPath = join(dataDir, "export.json");
    const saved = await runJSON(["export", "--out", outPath]);
    expect(saved.saved).toBe(outPath);
    expect(saved.count).toBe(snapshot.memories.length);
  });

  it("import loads memories from a JSON snapshot file", async () => {
    const importFile = join(dataDir, "import.json");
    writeFileSync(
      importFile,
      JSON.stringify({
        version: 1,
        memories: [
          {
            id: "mem_imported_1",
            actorId: "laura",
            content: "imported memory",
            memoryType: "interaction",
            importance: 0.5,
            emotionalValence: 0,
            tags: [],
            createdAt: new Date().toISOString(),
          },
        ],
        exportedAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const result = await runJSON(["import", "--actor", "laura", "--file", importFile]);
    expect(result.imported).toBe(1);

    const retrieved = await runJSON(["retrieve", "--actor", "laura"]);
    expect(retrieved.some((m: { content: string }) => m.content === "imported memory")).toBe(true);
  });

  it("import fails with a clear error when --file is missing", async () => {
    const { status, stderr } = await run(["import", "--actor", "laura"], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain("--file is required");
  });

  it("exits non-zero for an unknown command, pointing at --help", async () => {
    const { status, stderr } = await run(["bogus-command"], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain("Unknown command: bogus-command. Run memstack --help");
  });

  it("prints usage and exits non-zero with no command", async () => {
    const { status, stderr } = await run([], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain("memstack <command>");
  });
});

describe("help and version", () => {
  // No LLM key or storage: help must work before anything is configured.
  const env = cleanEnv({ MEMSTACK_HOME: "/nonexistent-memstack-home" });
  const commands = ["init", "connect", "disconnect", "status", "doctor", "memories", "project", "store", "retrieve", "context", "summarize", "prune", "purge", "merge", "stats", "delete", "health", "export", "import"];

  it("--version and -v print the package version", async () => {
    const { version } = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    for (const flag of ["--version", "-v"]) {
      const { status, stdout } = await run([flag], env);
      expect(status).toBe(0);
      expect(stdout.trim()).toBe(version);
    }
  });

  it("--help and -h print top-level usage to stdout", async () => {
    for (const flag of ["--help", "-h"]) {
      const { status, stdout } = await run([flag], env);
      expect(status).toBe(0);
      expect(stdout).toContain("memstack <command>");
    }
  });

  it.each(commands)("%s --help and help %s print that command's flags", async (command) => {
    for (const args of [[command, "--help"], ["help", command]]) {
      const { status, stdout, stderr } = await run(args, env);
      expect(status, stderr).toBe(0);
      expect(stdout).toContain(`memstack ${command}`);
    }
  });

  it("every command in the usage text has help", async () => {
    const { stdout } = await run(["--help"], env);
    const listed = [...stdout.matchAll(/^  ([a-z]+) {2,}/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...commands].sort());
  });

  it("help for an unknown command fails", async () => {
    const { status, stderr } = await run(["help", "bogus"], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain("Unknown command: bogus");
  });
});

describe("--project and the config file", () => {
  let home: string;
  let repo: string;
  let mockLLM: { server: Server; baseURL: string };

  beforeAll(async () => {
    mockLLM = await startMockLLM();
    home = mkdtempSync(join(tmpdir(), "memstack-home-"));
    repo = mkdtempSync(join(tmpdir(), "memstack-repo-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ version: 1, llm: { provider: "openai-compatible", apiKey: "sk-test", baseURL: mockLLM.baseURL }, storage: { type: "disk", path: join(home, "data") } }),
      { mode: 0o600 },
    );
  });

  afterAll(() => {
    mockLLM?.server.close();
    for (const d of [home, repo]) if (d) rmSync(d, { recursive: true, force: true });
  });

  const env = () => cleanEnv({ MEMSTACK_HOME: home, MEMSTACK_EMBED_ON_STORE: "false" });

  it("memory commands read ~/.memstack/config.json when no variables are set", async () => {
    const { status, stdout, stderr } = await run(["store", "--actor", "a", "--content", "from the config file"], env(), repo);
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout).content).toBe("from the config file");
  });

  it("--project stores under this repository's project, which memstack memories lists", async () => {
    const project = await run(["project"], env(), repo);
    const id = project.stdout.match(/[0-9a-f]{16}/)?.[0];
    expect(id).toBeDefined();

    const stored = await run(["store", "--project", "--content", "staging is at staging.example.dev"], env(), repo);
    expect(stored.status, stored.stderr).toBe(0);
    expect(JSON.parse(stored.stdout).actorId).toBe(`project:${id}`);

    const listed = await run(["memories"], env(), repo);
    expect(listed.stdout).toContain("staging is at staging.example.dev");
  });

  it("rejects --project together with --actor", async () => {
    const { status, stderr } = await run(["store", "--project", "--actor", "a", "--content", "x"], env(), repo);
    expect(status).not.toBe(0);
    expect(stderr).toContain("either --actor or --project");
  });

  it("status says when environment variables configure MemStack without a config file", async () => {
    const empty = mkdtempSync(join(tmpdir(), "memstack-empty-"));
    try {
      const vars = cleanEnv({ MEMSTACK_HOME: empty, OPENAI_API_KEY: "sk-test", MEMSTACK_LLM_MODEL: "m1", MEMSTACK_STORAGE: "sqlite", SQLITE_PATH: "/data/m.db", PATH: "/usr/bin:/bin" });
      const { stdout } = await run(["status"], vars, repo);
      expect(stdout).toMatch(/Config: +none, using environment variables/);
      expect(stdout).toMatch(/LLM: +openai-compatible \(m1\) \(from environment variables\)/);
      expect(stdout).toMatch(/Storage: +sqlite at \/data\/m\.db \(from environment variables\)/);

      const none = await run(["status"], cleanEnv({ MEMSTACK_HOME: empty, PATH: "/usr/bin:/bin" }), repo);
      expect(none.stdout).toMatch(/Config: +none \(run `memstack init`\)/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("status reports the config file and marks sections the environment overrides", async () => {
    const { stdout } = await run(["status"], cleanEnv({ MEMSTACK_HOME: home, MEMSTACK_STORAGE: "memory", PATH: "/usr/bin:/bin" }), repo);
    expect(stdout).toContain(`Config:       ${join(home, "config.json")}`);
    expect(stdout).toMatch(/LLM: +openai-compatible at http:\/\/127\.0\.0\.1:\d+\n/);
    expect(stdout).toMatch(/Storage: +memory \(lost when the process exits\) \(from environment variables\)/);
  });
});

describe("running without an LLM key", () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "memstack-nokey-"));
  });

  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const env = () => cleanEnv({ MEMSTACK_HOME: home });

  it("init --no-llm saves a config without a key and says tags are skipped", async () => {
    const { status, stdout, stderr } = await run(["init", "--yes", "--no-llm", "--store", "disk", "--path", join(home, "data")], env());
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("No LLM key: memories are saved without topic tags");
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(saved.llm).toBeUndefined();
    expect(saved.storage.type).toBe("disk");
  });

  it("status explains that memories are saved without topic tags", async () => {
    const { status, stdout, stderr } = await run(["status"], env());
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("saved without topic tags");
  });

  it("memory commands that need the LLM still ask for a key", async () => {
    const { status, stderr } = await run(["store", "--actor", "a", "--content", "x"], env());
    expect(status).not.toBe(0);
    expect(stderr).toContain("OPENAI_API_KEY or ANTHROPIC_API_KEY");
  });
});
