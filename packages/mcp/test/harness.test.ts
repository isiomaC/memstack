import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HarnessMemory, InMemoryStorageAdapter } from "@memstack/core";
import { createHarnessServer, HARNESS_INSTRUCTIONS } from "../src/harness.js";

const llm = {
  async complete() {
    return { text: '["framework", "backend"]', tokens: { prompt: 1, completion: 1, total: 2 } };
  },
};

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

async function connect(storage: InMemoryStorageAdapter, projectId: string, harness = "claude-code") {
  const memory = new HarnessMemory({ storage, llm });
  const server = createHarnessServer({ memory, projectId, harness, cwd: "/repo" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call };
}

const textOf = (result: ToolResult) => result.content.map((c) => c.text).join("\n");
const idIn = (result: ToolResult) => textOf(result).match(/mem_[a-z0-9_]+/)![0];

describe("harness MCP profile", () => {
  let storage: InMemoryStorageAdapter;

  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  it("exposes exactly the five harness tools, without actorId", async () => {
    const { client } = await connect(storage, "p1");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["memory_store", "memory_retrieve", "memory_get", "memory_delete", "memory_stats"]);
    for (const tool of tools) expect(JSON.stringify(tool.inputSchema)).not.toContain("actorId");
  });

  it("refuses to store a secret, says why without echoing it, and stores nothing", async () => {
    const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const { call } = await connect(storage, "p1");

    const result = await call("memory_store", { content: `Deploy with ${secret}` });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("github-token");
    expect(textOf(result)).not.toContain(secret);
    expect(textOf(await call("memory_retrieve", {}))).toContain("No memories yet");
  });

  it("sends server instructions whose first 512 characters stand alone", async () => {
    const { client } = await connect(storage, "p1");
    expect(client.getInstructions()).toBe(HARNESS_INSTRUCTIONS);
    const head = HARNESS_INSTRUCTIONS.slice(0, 512);
    expect(head).toContain("memory_retrieve");
    expect(head).toContain("memory_store");
    expect(head).toContain("Never store secrets");
    expect(head).toContain("Do not write it into README");
  });

  it("stores and recalls with provenance", async () => {
    const { call } = await connect(storage, "p1");
    const stored = await call("memory_store", { content: "This project uses Hono", kind: "decision" });
    expect(textOf(stored)).toMatch(/Stored mem_\S+ \(project, decision\)\. Tags: framework, backend\./);

    const recalled = await call("memory_retrieve", { query: "What framework do we use?" });
    expect(textOf(recalled)).toMatch(/\[mem_\S+\] This project uses Hono \(decision, project, from claude-code, \d{4}-\d{2}-\d{2}\)/);

    const memory = await storage.get(idIn(stored));
    expect(memory).toMatchObject({ actorId: "project:p1", metadata: { source: { harness: "claude-code", project: "p1", cwd: "/repo" } } });
  });

  it("shares a project between harnesses and isolates other projects", async () => {
    const claude = await connect(storage, "p1", "claude-code");
    const codex = await connect(storage, "p1", "codex");
    const other = await connect(storage, "p2", "codex");

    await claude.call("memory_store", { content: "This project uses Hono" });
    expect(textOf(await codex.call("memory_retrieve", { query: "framework" }))).toContain("This project uses Hono");
    expect(textOf(await other.call("memory_retrieve", { query: "framework" }))).toBe("No memories yet for this project.");
  });

  it("writes global memories only when asked, and recalls them in every project", async () => {
    const p1 = await connect(storage, "p1");
    const p2 = await connect(storage, "p2");
    await p1.call("memory_store", { content: "Prefer small pull requests", kind: "preference", scope: "global" });

    const recalled = await p2.call("memory_retrieve", { query: "pull requests" });
    expect(textOf(recalled)).toContain("Prefer small pull requests (preference, global");
    expect(textOf(await p2.call("memory_stats"))).toBe("Project p2 (/repo): 0 memories. Global: 1.");
  });

  it("refuses to get or delete another project's memory", async () => {
    const p1 = await connect(storage, "p1");
    const p2 = await connect(storage, "p2");
    const id = idIn(await p1.call("memory_store", { content: "Private to p1" }));

    const got = await p2.call("memory_get", { id });
    expect(got.isError).toBe(true);
    expect(textOf(got)).toContain("not found in this project");

    const deleted = await p2.call("memory_delete", { id });
    expect(deleted.isError).toBe(true);
    expect(await storage.get(id)).not.toBeNull();

    expect(textOf(await p1.call("memory_delete", { id }))).toBe(`Deleted ${id}.`);
    expect(await storage.get(id)).toBeNull();
  });

  it("returns details for memory_get", async () => {
    const { call } = await connect(storage, "p1");
    const id = idIn(await call("memory_store", { content: "Never commit to main", kind: "instruction", importance: 0.9 }));
    expect(textOf(await call("memory_get", { id }))).toMatch(/importance: 0\.9\ntags: framework, backend\nproject: p1/);
  });

  it("says when recall falls back because nothing matched", async () => {
    const { call } = await connect(storage, "p1");
    await call("memory_store", { content: "Deploys happen on Fridays" });
    const recalled = await call("memory_retrieve", { query: "kubernetes" });
    expect(textOf(recalled)).toMatch(/^Nothing matched "kubernetes"\. The most important memories instead:/);
  });

  it.each([
    ["memory_store", {}, /content/],
    ["memory_store", { content: "x", importance: 2 }, /importance/],
    ["memory_store", { content: "x", scope: "project:p2" }, /scope/],
    ["memory_retrieve", { limit: 100 }, /limit/],
    ["memory_get", {}, /id/],
  ])("rejects invalid %s arguments %o", async (name, args, message) => {
    const { call } = await connect(storage, "p1");
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(message);
  });

  it("ignores unknown arguments, says so, and never lets them choose the project", async () => {
    const { call } = await connect(storage, "p1");
    const stored = await call("memory_store", { content: "Deploys use fly deploy", actorId: "project:p2", project_id: "p2" });
    expect(stored.isError).toBeFalsy();
    expect(textOf(stored)).toMatch(/Ignored unknown arguments: actorId, project_id\. The project comes from the working directory\./);
    expect(await storage.retrieve({ actorId: "project:p2" })).toHaveLength(0);
    expect(await storage.retrieve({ actorId: "project:p1" })).toHaveLength(1);

    // A model adding project_id to memory_retrieve still gets its memories on the first call.
    const recalled = await call("memory_retrieve", { query: "deploy", project_id: "p1" });
    expect(recalled.isError).toBeFalsy();
    expect(textOf(recalled)).toMatch(/Deploys use fly deploy/);
    expect(textOf(recalled)).toMatch(/Ignored unknown argument: project_id\./);
  });

  it("caps memory_retrieve output", async () => {
    const { call } = await connect(storage, "p1");
    for (let i = 0; i < 5; i++) await call("memory_store", { content: `hono ${String(i).repeat(3000)}` });
    const recalled = textOf(await call("memory_retrieve", { query: "hono", limit: 25 }));
    expect(recalled.length).toBeLessThan(9000);
  });
});

const distCli = new URL("../dist/cli.js", import.meta.url).pathname;

describe.skipIf(!existsSync(distCli))("memstack-mcp --profile harness over stdio", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "memstack-harness-")));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/demo.git"]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function start(env: Record<string, string>) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "--profile", "harness", "--harness", "codex"],
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        MEMSTACK_HOME: join(dir, ".memstack-home"),
        OPENAI_API_KEY: "sk-test",
        MEMSTACK_OPENAI_BASE_URL: "http://127.0.0.1:9",
        MEMSTACK_STORAGE: "disk",
        MEMSTACK_DIR: join(dir, ".memstack-data"),
        ...env,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  it("resolves the project from the working directory and persists memories", async () => {
    const first = await start({});
    const stored = (await first.callTool({ name: "memory_store", arguments: { content: "This project uses Hono" } })) as ToolResult;
    expect(stored.isError).toBeFalsy();
    const stats = textOf((await first.callTool({ name: "memory_stats", arguments: {} })) as ToolResult);
    expect(stats).toMatch(new RegExp(`^Project [0-9a-f]{16} \\(${dir}\\): 1 memories\\.`));
    await first.close();

    const second = await start({});
    const recalled = (await second.callTool({ name: "memory_retrieve", arguments: { query: "hono" } })) as ToolResult;
    expect(textOf(recalled)).toContain("This project uses Hono (fact, project, from codex");
    await second.close();
  }, 30_000);

  it("prefers CLAUDE_PROJECT_DIR over the working directory", async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "memstack-other-")));
    try {
      const client = await start({ CLAUDE_PROJECT_DIR: other });
      const stats = textOf((await client.callTool({ name: "memory_stats", arguments: {} })) as ToolResult);
      expect(stats).toContain(`(${other})`);
      await client.close();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 30_000);
});
