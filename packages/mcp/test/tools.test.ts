import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryStorageAdapter, MemStack } from "@memstack/core";
import { createServer } from "../src/server.js";

const mockLLM = {
  async complete() {
    return { text: "response", tokens: { prompt: 10, completion: 5, total: 15 } };
  },
};

async function connectedClient(ms?: MemStack) {
  const config = { llm: mockLLM as never, storage: new InMemoryStorageAdapter() };
  const server = createServer(ms ? { config, defaultActorId: "test-actor", ms } : { config, defaultActorId: "test-actor" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function toolResult(result: { content: { type: string; text?: string }[] }) {
  const text = result.content[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

describe("MCP tools — full coverage", () => {
  it("lists all 18 tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "memory_process",
        "memory_store",
        "memory_store_batch",
        "memory_get",
        "memory_retrieve",
        "memory_compile_context",
        "memory_summarize",
        "memory_prune",
        "memory_purge_actor",
        "memory_merge",
        "memory_stats",
        "memory_delete",
        "memory_delete_many",
        "memory_touch",
        "memory_export",
        "memory_import",
        "memory_health",
        "memory_dry_run_prune",
      ]),
    );
  });

  it("memory_store_batch stores multiple memories in one call", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "memory_store_batch",
      arguments: { memories: [{ content: "first" }, { content: "second" }] },
    });
    const memories = toolResult(result as never);
    expect(memories).toHaveLength(2);
    expect(memories[0].content).toBe("first");
    expect(memories[1].content).toBe("second");
  });

  it("memory_get returns a stored memory by ID", async () => {
    const client = await connectedClient();
    const stored = toolResult(
      (await client.callTool({ name: "memory_store", arguments: { content: "findme" } })) as never,
    );
    const fetched = toolResult(
      (await client.callTool({ name: "memory_get", arguments: { id: stored.id } })) as never,
    );
    expect(fetched.content).toBe("findme");
  });

  it("memory_get returns null for a missing ID", async () => {
    const client = await connectedClient();
    const result = toolResult(
      (await client.callTool({ name: "memory_get", arguments: { id: "mem_nonexistent" } })) as never,
    );
    expect(result).toBeNull();
  });

  it("memory_delete_many deletes multiple memories and returns the count", async () => {
    const client = await connectedClient();
    const a = toolResult((await client.callTool({ name: "memory_store", arguments: { content: "a" } })) as never);
    const b = toolResult((await client.callTool({ name: "memory_store", arguments: { content: "b" } })) as never);
    const result = toolResult(
      (await client.callTool({ name: "memory_delete_many", arguments: { ids: [a.id, b.id] } })) as never,
    );
    expect(result.deleted).toBe(2);
  });

  it("memory_touch bumps recency without erroring", async () => {
    const client = await connectedClient();
    const stored = toolResult(
      (await client.callTool({ name: "memory_store", arguments: { content: "touch me" } })) as never,
    );
    const result = toolResult(
      (await client.callTool({ name: "memory_touch", arguments: { id: stored.id } })) as never,
    );
    expect(result.touched).toBe(true);
  });

  it("memory_export then memory_import round-trips a memory", async () => {
    const ms = new MemStack({ llm: mockLLM as never, storage: new InMemoryStorageAdapter() });
    const clientA = await connectedClient(ms);
    await clientA.callTool({ name: "memory_store", arguments: { content: "exported memory", actorId: "test-actor" } });

    const exported = toolResult(
      (await clientA.callTool({ name: "memory_export", arguments: {} })) as never,
    );
    expect(exported.memories.length).toBeGreaterThanOrEqual(1);

    const freshMs = new MemStack({ llm: mockLLM as never, storage: new InMemoryStorageAdapter() });
    const clientB = await connectedClient(freshMs);
    const imported = toolResult(
      (await clientB.callTool({ name: "memory_import", arguments: { memories: exported.memories } })) as never,
    );
    expect(imported.imported).toBe(exported.memories.length);

    const retrieved = toolResult(
      (await clientB.callTool({ name: "memory_retrieve", arguments: { actorId: "test-actor" } })) as never,
    );
    expect(retrieved.some((m: { content: string }) => m.content === "exported memory")).toBe(true);
  });

  it("createServer reuses a provided MemStack instance instead of constructing a new one", async () => {
    const ms = new MemStack({ llm: mockLLM as never, storage: new InMemoryStorageAdapter() });
    const clientA = await connectedClient(ms);
    const stored = toolResult(
      (await clientA.callTool({ name: "memory_store", arguments: { content: "shared instance" } })) as never,
    );

    // A second server built with the *same* ms instance should see data the first wrote.
    const clientB = await connectedClient(ms);
    const fetched = toolResult(
      (await clientB.callTool({ name: "memory_get", arguments: { id: stored.id } })) as never,
    );
    expect(fetched.content).toBe("shared instance");
  });
});
