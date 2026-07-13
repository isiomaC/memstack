import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
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

describe("memstack CLI commands", () => {
  let mockLLM: { server: Server; baseURL: string };
  let dataDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    execFileSync("npx", ["tsup", "src/cli.ts", "--format", "esm", "--clean"], {
      cwd: PKG_ROOT,
      stdio: "inherit",
    });
    mockLLM = await startMockLLM();
    dataDir = mkdtempSync(join(tmpdir(), "memstack-cli-test-"));
    env = {
      ...process.env,
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

  it("prints usage and exits non-zero for an unknown command", async () => {
    const { status, stderr } = await run(["bogus-command"], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain("memstack <command>");
  });

  it("prints usage and exits non-zero with no command", async () => {
    const { status, stderr } = await run([], env);
    expect(status).not.toBe(0);
    expect(stderr).toContain("memstack <command>");
  });
});
