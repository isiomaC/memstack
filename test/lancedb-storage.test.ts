import { describe, it, expect, beforeEach } from "vitest";
import { LanceDBStorageAdapter } from "../src/adapters/storage/lancedb.js";

function createMockLanceDB() {
  const rows: Record<string, unknown>[] = [];
  const mockTable = {
    async add(data: Record<string, unknown>[]) { rows.push(...data); },
    search() {
      return {
        limit(_n: number) {
          return {
            where(_pred: string) {
              return { execute: async () => rows.map(r => ({ ...r, _distance: 0 })) as Record<string, unknown>[] };
            },
          };
        },
      };
    },
    async delete(pred: string) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (pred.includes(rows[i].id as string)) rows.splice(i, 1);
      }
    },
    async countRows() { return rows.length; },
  };

  let createTableCalled = false;
  let openTableCalled = false;

  return {
    mockTable,
    rows,
    createTableCalled: () => createTableCalled,
    openTableCalled: () => openTableCalled,
    connection: {
      async createTable() { createTableCalled = true; return mockTable; },
      async openTable() { openTableCalled = true; return mockTable; },
      async tableNames() { return []; },
    },
  };
}

describe("LanceDBStorageAdapter", () => {
  it("constructs with required config", () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    expect(adapter).toBeDefined();
  });

  it("creates table on initialize when table does not exist", async () => {
    const mock = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection: mock.connection });
    await adapter.initialize();
    expect(mock.createTableCalled()).toBe(true);
    expect(mock.openTableCalled()).toBe(false);
  });

  it("opens existing table on initialize", async () => {
    const mock = createMockLanceDB();
    mock.connection.tableNames = async () => ["memstack"];
    const adapter = new LanceDBStorageAdapter({ connection: mock.connection });
    await adapter.initialize();
    expect(mock.openTableCalled()).toBe(true);
    expect(mock.createTableCalled()).toBe(false);
  });

  it("generates id in correct format", () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    const id = adapter.generateId();
    expect(id).toMatch(/^mem_[a-z0-9]+_[a-f0-9]{8}$/);
  });

  it("stores and retrieves a memory", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    const mem = await adapter.store({
      actorId: "npc_1",
      content: "Hello world",
    });

    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("npc_1");
    expect(mem.content).toBe("Hello world");
    expect(mem.memoryType).toBe("interaction");
    expect(mem.createdAt).toBeInstanceOf(Date);

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Hello world");
  });

  it("returns null for missing memory", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    const mem = await adapter.store({ actorId: "a", content: "test" });
    await adapter.delete(mem.id);

    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("counts memories by filter", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "b", content: "3" });

    expect(await adapter.count({ actorId: "a" })).toBe(2);
    expect(await adapter.count({ actorId: "b" })).toBe(1);
    expect(await adapter.count()).toBe(3);
  });

  it("stores batch", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await adapter.count()).toBe(2);
  });

  it("retrieves by semantic search with embedding", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "semantic result", embedding: [0.1, 0.2, 0.3] });

    const results = await adapter.retrieve(
      { actorId: "a", strategy: "semantic", limit: 5 },
      [0.1, 0.2, 0.3]
    );

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("semantic result");
  });

  it("retrieves by recency strategy", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "old memory", importance: 0.1 });
    await new Promise((r) => setTimeout(r, 5));
    await adapter.store({ actorId: "a", content: "latest memory", importance: 0.1 });

    const results = await adapter.retrieve({ actorId: "a", strategy: "recent", limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("latest memory");
  });

  it("retrieves by importance strategy", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "low importance", importance: 0.1 });
    await adapter.store({ actorId: "a", content: "high importance", importance: 0.9 });

    const results = await adapter.retrieve({ actorId: "a", strategy: "important", limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("high importance");
  });

  it("filters by tags", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "tagged", tags: ["combat"] });
    await adapter.store({ actorId: "a", content: "untagged", tags: ["exploration"] });

    const results = await adapter.retrieve({ actorId: "a", tags: ["combat"] });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("tagged");
  });

  it("filters by query text", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "The goblin attacked" });
    await adapter.store({ actorId: "a", content: "A dragon appeared" });

    const results = await adapter.retrieve({ actorId: "a", query: "goblin" });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("The goblin attacked");
  });

  it("filters expired memories", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    const past = new Date(Date.now() - 10_000);
    await adapter.store({ actorId: "a", content: "expired", expiresAt: past });
    await adapter.store({ actorId: "a", content: "valid" });

    const count = await adapter.count({ actorId: "a" });
    expect(count).toBe(1);

    const results = await adapter.retrieve({ actorId: "a" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("valid");
  });

  it("deleteMany removes multiple memories", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    const m1 = await adapter.store({ actorId: "a", content: "1" });
    const m2 = await adapter.store({ actorId: "a", content: "2" });
    const m3 = await adapter.store({ actorId: "a", content: "3" });

    const deleted = await adapter.deleteMany([m1.id, m3.id]);
    expect(deleted).toBe(2);
    expect(await adapter.count({ actorId: "a" })).toBe(1);
  });

  it("stores and retrieves with tags and metadata", async () => {
    const { connection } = createMockLanceDB();
    const adapter = new LanceDBStorageAdapter({ connection });
    await adapter.initialize();

    const mem = await adapter.store({
      actorId: "npc_1",
      content: "Complex memory",
      tags: ["quest", "urgent"],
      metadata: { location: "forest", priority: 1 },
      sourceId: "src_123",
    });

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tags).toEqual(["quest", "urgent"]);
    expect(retrieved!.metadata).toEqual({ location: "forest", priority: 1 });
    expect(retrieved!.sourceId).toBe("src_123");
  });
});
