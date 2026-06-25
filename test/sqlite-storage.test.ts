import { describe, it, expect, beforeEach } from "vitest";
import { SQLiteStorageAdapter } from "../src/adapters/storage/sqlite.js";

type BetterSqlite3Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown | undefined;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

function createMockDb(rows?: Map<string, Record<string, unknown>>): BetterSqlite3Db {
  const store = rows ?? new Map<string, Record<string, unknown>>();
  return {
    exec(_sql: string) {},
    prepare(_sql: string) {
      const sql = _sql.toLowerCase();
      return {
        run(..._params: unknown[]) {
          if (sql.startsWith("insert") || sql.startsWith("update") || sql.startsWith("delete")) {
            return { changes: 1, lastInsertRowid: 1n };
          }
          return { changes: 0, lastInsertRowid: 0n };
        },
        get(..._params: unknown[]) {
          if (sql.includes("count(*)")) return { count: 0 };
          return null;
        },
        all(..._params: unknown[]) {
          return [];
        },
      };
    },
    close() {},
  };
}

describe("SQLiteStorageAdapter (mocked)", () => {
  it("constructs with valid config", () => {
    const db = createMockDb();
    const adapter = new SQLiteStorageAdapter({ db });
    expect(adapter).toBeDefined();
  });

  it("constructs with custom tableName and vectorDimensions", () => {
    const db = createMockDb();
    const adapter = new SQLiteStorageAdapter({
      db,
      tableName: "custom_memories",
      vectorDimensions: 768,
    });
    expect(adapter).toBeDefined();
  });

  it("throws on missing db", () => {
    expect(() => new SQLiteStorageAdapter({ db: undefined as unknown as BetterSqlite3Db })).toThrow();
  });

  it("throws on invalid table name", () => {
    const db = createMockDb();
    expect(() => new SQLiteStorageAdapter({ db, tableName: "bad table; DROP TABLE" })).toThrow(/Invalid table name/);
  });

  it("generates IDs with mem_ prefix", () => {
    const db = createMockDb();
    const adapter = new SQLiteStorageAdapter({ db });
    const id = adapter.generateId();
    expect(id).toMatch(/^mem_[a-z0-9]+_[a-f0-9]{8}$/);
  });

  it("generates unique IDs on each call", () => {
    const db = createMockDb();
    const adapter = new SQLiteStorageAdapter({ db });
    const ids = new Set(Array.from({ length: 100 }, () => adapter.generateId()));
    expect(ids.size).toBe(100);
  });

  it("initializes without error", async () => {
    const db = createMockDb();
    const adapter = new SQLiteStorageAdapter({ db });
    await expect(adapter.initialize()).resolves.toBeUndefined();
  });

  it("closes and calls db.close", () => {
    let closed = false;
    const db: BetterSqlite3Db = {
      exec() {},
      prepare() {
        return {
          run() { return { changes: 0, lastInsertRowid: 0n }; },
          get() { return null; },
          all() { return []; },
        };
      },
      close() { closed = true; },
    };
    const adapter = new SQLiteStorageAdapter({ db });
    adapter.close();
    expect(closed).toBe(true);
  });
});

// Integration tests using :memory: — skip if better-sqlite3 is not installed
describe("SQLiteStorageAdapter (integration)", () => {
  let adapter: SQLiteStorageAdapter;

  beforeEach(async () => {
    const db = await getBetterSqlite3();
    if (!db) return;
    adapter = new SQLiteStorageAdapter({ db });
    await adapter.initialize();
  });

  async function getBetterSqlite3(): Promise<BetterSqlite3Db | null> {
    try {
      const mod = await import("better-sqlite3");
      const Database = mod.default as unknown as new (filename: string) => BetterSqlite3Db;
      return new Database(":memory:");
    } catch {
      return null;
    }
  }

  it("stores and retrieves a memory", async () => {
    if (!adapter) return;
    const mem = await adapter.store({ actorId: "npc_1", content: "Hello world" });

    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("npc_1");
    expect(mem.content).toBe("Hello world");
    expect(mem.memoryType).toBe("interaction");
    expect(mem.importance).toBe(0.5);
    expect(mem.emotionalValence).toBe(0);
    expect(mem.tags).toEqual([]);
    expect(mem.createdAt).toBeInstanceOf(Date);

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Hello world");
  });

  it("returns null for missing memory", async () => {
    if (!adapter) return;
    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    if (!adapter) return;
    const mem = await adapter.store({ actorId: "a", content: "test" });

    await adapter.delete(mem.id);
    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("counts by actorId", async () => {
    if (!adapter) return;
    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "b", content: "3" });

    expect(await adapter.count({ actorId: "a" })).toBe(2);
    expect(await adapter.count({ actorId: "b" })).toBe(1);
    expect(await adapter.count()).toBe(3);
  });

  it("retrieves by strategy", async () => {
    if (!adapter) return;
    await adapter.store({ actorId: "a", content: "old", importance: 0.1 });
    await adapter.store({ actorId: "a", content: "important", importance: 0.9 });

    const results = await adapter.retrieve({ actorId: "a", strategy: "important", limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("important");
  });

  it("retrieves by query text", async () => {
    if (!adapter) return;
    await adapter.store({ actorId: "a", content: "The goblin attacked" });
    await adapter.store({ actorId: "a", content: "A dragon appeared" });

    const results = await adapter.retrieve({ actorId: "a", query: "goblin" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("The goblin attacked");
  });

  it("stores batch", async () => {
    if (!adapter) return;
    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await adapter.count()).toBe(2);
  });

  it("filters expired memories", async () => {
    if (!adapter) return;
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
    if (!adapter) return;
    const m1 = await adapter.store({ actorId: "a", content: "1" });
    const m2 = await adapter.store({ actorId: "a", content: "2" });
    const m3 = await adapter.store({ actorId: "a", content: "3" });

    const deleted = await adapter.deleteMany([m1.id, m3.id]);
    expect(deleted).toBe(2);
    expect(await adapter.count({ actorId: "a" })).toBe(1);
  });

  it("stores and retrieves tags", async () => {
    if (!adapter) return;
    const mem = await adapter.store({
      actorId: "a",
      content: "tagged",
      tags: ["combat", "quest"],
    });

    expect(mem.tags).toEqual(["combat", "quest"]);

    const retrieved = await adapter.get(mem.id);
    expect(retrieved!.tags).toEqual(["combat", "quest"]);
  });

  it("stores and retrieves metadata", async () => {
    if (!adapter) return;
    const mem = await adapter.store({
      actorId: "a",
      content: "metad",
      metadata: { hp: 42, location: "tavern" },
    });

    expect(mem.metadata).toEqual({ hp: 42, location: "tavern" });

    const retrieved = await adapter.get(mem.id);
    expect(retrieved!.metadata).toEqual({ hp: 42, location: "tavern" });
  });

  it("stores and retrieves embedding", async () => {
    if (!adapter) return;
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    const mem = await adapter.store({
      actorId: "a",
      content: "embedded",
      embedding,
    });

    expect(mem.embedding).toEqual(embedding);

    const retrieved = await adapter.get(mem.id);
    expect(retrieved!.embedding).toEqual(embedding);
  });

  it("retrieves by memoryType filter", async () => {
    if (!adapter) return;
    await adapter.store({ actorId: "a", content: "interaction", memoryType: "interaction" });
    await adapter.store({ actorId: "a", content: "fact", memoryType: "fact" });
    await adapter.store({ actorId: "a", content: "observation", memoryType: "observation" });

    const results = await adapter.retrieve({
      actorId: "a",
      memoryTypes: ["fact", "observation"],
    });
    expect(results).toHaveLength(2);
    const types = results.map((r) => r.memoryType).sort();
    expect(types).toEqual(["fact", "observation"]);
  });

  it("retrieves by tags filter", async () => {
    if (!adapter) return;
    await adapter.store({ actorId: "a", content: "combat", tags: ["combat"] });
    await adapter.store({ actorId: "a", content: "quest", tags: ["quest"] });
    await adapter.store({ actorId: "a", content: "both", tags: ["combat", "quest"] });

    const results = await adapter.retrieve({ actorId: "a", tags: ["combat"] });
    expect(results).toHaveLength(2);
    const contents = results.map((r) => r.content).sort();
    expect(contents).toEqual(["both", "combat"]);
  });

  it("touch updates touched_at", async () => {
    if (!adapter) return;
    const mem = await adapter.store({ actorId: "a", content: "touchable" });

    const before = await adapter.get(mem.id);
    await new Promise((r) => setTimeout(r, 10));
    await adapter.touch!(mem.id);
    const after = await adapter.get(mem.id);

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(before!.createdAt.getTime()).toBe(after!.createdAt.getTime());
  });

  it("respects custom id on store", async () => {
    if (!adapter) return;
    const mem = await adapter.store({
      id: "my-custom-id",
      actorId: "a",
      content: "custom",
    });

    expect(mem.id).toBe("my-custom-id");

    const retrieved = await adapter.get("my-custom-id");
    expect(retrieved!.content).toBe("custom");
  });

  it("closes the database", async () => {
    if (!adapter) return;
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
