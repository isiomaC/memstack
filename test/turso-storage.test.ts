import { describe, it, expect } from "vitest";
import { TursoStorageAdapter } from "../src/adapters/storage/turso.js";

type LibSQLClient = {
  execute(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowsAffected: number }>;
  batch(queries: string[]): Promise<unknown[]>;
  close(): Promise<void>;
};

function createMockLibSQLClient(rows: unknown[] = [], rowsAffected = 0): LibSQLClient {
  return {
    async execute(_sql: string, _params?: unknown[]) {
      return { rows, rowsAffected };
    },
    async batch(_queries: string[]) {
      return [];
    },
    async close() {},
  };
}

describe("TursoStorageAdapter", () => {
  it("constructs with valid config", () => {
    const client = createMockLibSQLClient();
    const adapter = new TursoStorageAdapter({ client });
    expect(adapter).toBeDefined();
    expect(adapter).toBeInstanceOf(TursoStorageAdapter);
  });

  it("constructs with custom tableName and vectorDimensions", () => {
    const client = createMockLibSQLClient();
    const adapter = new TursoStorageAdapter({
      client,
      tableName: "custom_memories",
      vectorDimensions: 768,
    });
    expect(adapter).toBeDefined();
  });

  it("throws on invalid table name", () => {
    const client = createMockLibSQLClient();
    expect(() => new TursoStorageAdapter({ client, tableName: "bad name!" })).toThrow(
      /Invalid table name/
    );
    expect(() => new TursoStorageAdapter({ client, tableName: "drop;table" })).toThrow(
      /Invalid table name/
    );
    expect(() => new TursoStorageAdapter({ client, tableName: "" })).toThrow(
      /Invalid table name/
    );
  });

  it("generates IDs with mem_ prefix", () => {
    const client = createMockLibSQLClient();
    const adapter = new TursoStorageAdapter({ client });
    const id = adapter.generateId();
    expect(id).toMatch(/^mem_/);
    expect(id.length).toBeGreaterThan("mem_".length);
  });

  it("initializes by running migration", async () => {
    const calls: string[] = [];
    const client = createMockLibSQLClient();
    const origExecute = client.execute;
    client.execute = async (sql: string, params?: unknown[]) => {
      calls.push(typeof sql === "string" ? sql : "");
      return origExecute(sql, params);
    };

    const adapter = new TursoStorageAdapter({ client });
    await adapter.initialize();

    expect(calls.some((c) => c.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true);
    expect(calls.some((c) => c.includes("idx_memstack_memories_actor"))).toBe(true);
    expect(calls.some((c) => c.includes("idx_memstack_memories_created"))).toBe(true);
    expect(calls.some((c) => c.includes("idx_memstack_memories_importance"))).toBe(true);
  });

  it("initializes with custom table name in migration SQL", async () => {
    const calls: string[] = [];
    const client = createMockLibSQLClient();
    client.execute = async (sql: string, params?: unknown[]) => {
      calls.push(typeof sql === "string" ? sql : "");
      return { rows: [], rowsAffected: 0 };
    };

    const adapter = new TursoStorageAdapter({ client, tableName: "custom_table" });
    await adapter.initialize();

    const createCall = calls.find((c) => c.includes("CREATE TABLE IF NOT EXISTS"));
    expect(createCall).toBeDefined();
    expect(createCall).toContain("custom_table");
  });

  it("stores and retrieves a memory", async () => {
    const now = new Date().toISOString();
    const stored: unknown[][] = [];
    const client = createMockLibSQLClient();
    client.execute = async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.toUpperCase().startsWith("INSERT")) {
        stored.push(params ?? []);
        return { rows: [], rowsAffected: 1 };
      }
      return { rows: [], rowsAffected: 0 };
    };

    const adapter = new TursoStorageAdapter({ client });
    const mem = await adapter.store({
      actorId: "actor-1",
      content: "Hello Turso",
      importance: 0.8,
      tags: ["test"],
    });

    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("actor-1");
    expect(mem.content).toBe("Hello Turso");
    expect(mem.importance).toBe(0.8);
    expect(mem.tags).toEqual(["test"]);
    expect(mem.createdAt).toBeInstanceOf(Date);
    expect(stored.length).toBe(1);

    const params = stored[0];
    expect(params[0]).toBe(mem.id);
    expect(params[1]).toBe("actor-1");
    expect(params[2]).toBe("interaction");
    expect(params[3]).toBe("Hello Turso");
  });

  it("returns null for missing memory", async () => {
    const client = createMockLibSQLClient([]);
    const adapter = new TursoStorageAdapter({ client });
    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const client = createMockLibSQLClient(
      [{ id: "mem_test123" }]
    );
    const deleteCalls: string[] = [];
    client.execute = async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.toUpperCase().startsWith("DELETE")) {
        deleteCalls.push(sql);
        return { rows: [{ id: "mem_test123" }], rowsAffected: 1 };
      }
      return { rows: [{ id: "mem_test123" }], rowsAffected: 0 };
    };

    const adapter = new TursoStorageAdapter({ client });
    await adapter.delete("mem_test123");
    expect(deleteCalls.length).toBe(1);
  });

  it("throws notFound when deleting missing memory", async () => {
    const client = createMockLibSQLClient([]);
    const adapter = new TursoStorageAdapter({ client });
    await expect(adapter.delete("nonexistent")).rejects.toThrow(/NOT_FOUND|not found/);
  });

  it("touches a memory", async () => {
    const client = createMockLibSQLClient(
      [{ id: "mem_test456" }]
    );
    const updateCalls: string[] = [];
    client.execute = async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.toUpperCase().startsWith("UPDATE")) {
        updateCalls.push(sql);
        return { rows: [], rowsAffected: 1 };
      }
      return { rows: [{ id: "mem_test456" }], rowsAffected: 0 };
    };

    const adapter = new TursoStorageAdapter({ client });
    await adapter.touch("mem_test456");
    expect(updateCalls.length).toBe(1);
  });

  it("throws notFound when touching missing memory", async () => {
    const client = createMockLibSQLClient([]);
    const adapter = new TursoStorageAdapter({ client });
    await expect(adapter.touch("nonexistent")).rejects.toThrow(/NOT_FOUND|not found/);
  });

  it("counts memories with filters", async () => {
    const client = createMockLibSQLClient();
    client.execute = async (_sql: string, _params?: unknown[]) => {
      return { rows: [{ count: 5 }], rowsAffected: 0 };
    };

    const adapter = new TursoStorageAdapter({ client });
    const result = await adapter.count({ actorId: "a" });
    expect(result).toBe(5);
  });

  it("retrieves by recent strategy", async () => {
    const now = new Date().toISOString();
    const client = createMockLibSQLClient([
      {
        id: "mem_1",
        actor_id: "a",
        memory_type: "interaction",
        content: "recent memory",
        importance: 0.5,
        emotional_valence: 0,
        tags: "[]",
        embedding: null,
        source_id: null,
        metadata: "{}",
        expires_at: null,
        created_at: now,
        touched_at: now,
      },
    ]);
    const adapter = new TursoStorageAdapter({ client });
    const results = await adapter.retrieve({ actorId: "a", strategy: "recent", limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("recent memory");
  });

  it("retrieves by important strategy", async () => {
    const now = new Date().toISOString();
    const client = createMockLibSQLClient([
      {
        id: "mem_2",
        actor_id: "a",
        memory_type: "interaction",
        content: "important memory",
        importance: 0.9,
        emotional_valence: 0,
        tags: "[]",
        embedding: null,
        source_id: null,
        metadata: "{}",
        expires_at: null,
        created_at: now,
        touched_at: now,
      },
    ]);
    const adapter = new TursoStorageAdapter({ client });
    const results = await adapter.retrieve({ actorId: "a", strategy: "important", limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("important memory");
  });

  it("retrieves by query text", async () => {
    const now = new Date().toISOString();
    const client = createMockLibSQLClient([
      {
        id: "mem_3",
        actor_id: "a",
        memory_type: "interaction",
        content: "The goblin attacked",
        importance: 0.5,
        emotional_valence: 0,
        tags: "[]",
        embedding: null,
        source_id: null,
        metadata: "{}",
        expires_at: null,
        created_at: now,
        touched_at: now,
      },
    ]);
    const adapter = new TursoStorageAdapter({ client });
    const results = await adapter.retrieve({ actorId: "a", query: "goblin" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("The goblin attacked");
  });

  it("stores batch", async () => {
    const client = createMockLibSQLClient([], 1);
    const adapter = new TursoStorageAdapter({ client });
    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("one");
    expect(results[1].content).toBe("two");
    expect(results[0].id).toMatch(/^mem_/);
  });

  it("deleteMany removes multiple memories", async () => {
    const client = createMockLibSQLClient(
      [{ id: "mem_a" }, { id: "mem_c" }]
    );
    const adapter = new TursoStorageAdapter({ client });
    const deleted = await adapter.deleteMany(["mem_a", "mem_b", "mem_c"]);
    expect(deleted).toBe(2);
  });

  it("closes the client", async () => {
    let closed = false;
    const client = createMockLibSQLClient();
    client.close = async () => {
      closed = true;
    };
    const adapter = new TursoStorageAdapter({ client });
    await adapter.close();
    expect(closed).toBe(true);
  });

  it("retrieves with semantic strategy using embedding", async () => {
    const now = new Date().toISOString();
    const client = createMockLibSQLClient([
      {
        id: "mem_sem",
        actor_id: "a",
        memory_type: "interaction",
        content: "semantic match",
        importance: 0.5,
        emotional_valence: 0,
        tags: "[]",
        embedding: null,
        source_id: null,
        metadata: "{}",
        expires_at: null,
        created_at: now,
        touched_at: now,
      },
    ]);
    const adapter = new TursoStorageAdapter({ client });
    const embedding = new Array(1536).fill(0.1);
    const results = await adapter.retrieve(
      { actorId: "a", strategy: "semantic", limit: 5 },
      embedding
    );
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("semantic match");
  });
});
