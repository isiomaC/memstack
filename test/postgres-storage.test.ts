import { describe, it, expect, beforeEach } from "vitest";
import { PostgresStorageAdapter } from "../src/adapters/storage/postgres.js";

type MockRow = Record<string, unknown>;

function createMockPgPool() {
  const rows = new Map<string, MockRow>();

  function now(): Date {
    return new Date();
  }

  function isExpired(row: MockRow): boolean {
    const exp = row.expires_at as string | null;
    return exp !== null && exp !== undefined && new Date(exp) <= now();
  }

  function filterExpired(all: MockRow[]): MockRow[] {
    return all.filter((r) => !isExpired(r));
  }

  return {
    async query(text: string, params?: unknown[]) {
      const sql = text.trim().toLowerCase();

      if (sql.includes("create table") || sql.includes("create index") || sql.includes("create extension")) {
        return { rows: [] };
      }

      if (sql.startsWith("insert into")) {
        const id = params?.[0] as string;
        const embStr = params?.[7] as string | null;
        const embedding = embStr ? embStr.replace(/[{}]/g, "").split(",").map(Number).filter((n) => !isNaN(n)) : null;
        const row: MockRow = {
          id,
          actor_id: params?.[1],
          memory_type: params?.[2],
          content: params?.[3],
          importance: Number(params?.[4] ?? 0.5),
          emotional_valence: Number(params?.[5] ?? 0),
          tags: JSON.parse((params?.[6] as string) || "[]"),
          embedding: embedding && embedding.length > 0 ? embedding : null,
          source_id: params?.[8] ?? null,
          metadata: JSON.parse((params?.[9] as string) || "{}"),
          expires_at: params?.[10] ?? null,
          created_at: params?.[11],
          touched_at: params?.[12],
        };
        rows.set(id, row);
        return { rows: [row] };
      }

      if (sql.startsWith("select") && sql.includes("where id = $1")) {
        const id = params?.[0] as string;
        const row = rows.get(id);
        if (!row || isExpired(row)) return { rows: [] };
        return { rows: [row] };
      }

      if (sql.startsWith("delete from") && sql.includes("where id = $1") && !sql.includes("in (")) {
        const id = params?.[0] as string;
        const existed = rows.has(id);
        rows.delete(id);
        return { rows: existed ? [{ id }] : [] };
      }

      if (sql.startsWith("delete from") && sql.includes(" in (")) {
        const deleted: { id: string }[] = [];
        for (const p of params ?? []) {
          const id = p as string;
          if (rows.has(id)) {
            rows.delete(id);
            deleted.push({ id });
          }
        }
        return { rows: deleted };
      }

      if (sql.startsWith("update") && sql.includes("set touched_at")) {
        const id = params?.[0] as string;
        const row = rows.get(id);
        if (row) {
          row.touched_at = now().toISOString();
        }
        return { rows: [] };
      }

      if (sql.includes("count(*)")) {
        const all = filterExpired(Array.from(rows.values()));
        const actorMatch = sql.match(/actor_id\s*=\s*\$(\d+)/i);
        let filtered = all;
        if (actorMatch) {
          const idx = parseInt(actorMatch[1]) - 1;
          const actorId = params?.[idx] as string;
          filtered = all.filter((r) => r.actor_id === actorId);
        }
        return { rows: [{ count: String(filtered.length) }] };
      }

      if (sql.startsWith("select * from")) {
        let result = filterExpired(Array.from(rows.values()));

        const actorMatch = sql.match(/actor_id\s*=\s*\$(\d+)/i);
        if (actorMatch) {
          const idx = parseInt(actorMatch[1]) - 1;
          const actorId = params?.[idx] as string;
          result = result.filter((r) => r.actor_id === actorId);
        }

        if (sql.includes("importance desc")) {
          result.sort((a, b) => (b.importance as number) - (a.importance as number));
        } else if (sql.includes("touched_at desc")) {
          result.sort(
            (a, b) =>
              new Date(b.touched_at as string).getTime() -
              new Date(a.touched_at as string).getTime()
          );
        }

        const limitMatch = sql.match(/limit\s+\$(\d+)/i);
        if (limitMatch) {
          const idx = parseInt(limitMatch[1]) - 1;
          const limit = params?.[idx] as number;
          result = result.slice(0, limit);
        }

        return { rows: result };
      }

      return { rows: [] };
    },
  };
}

describe("PostgresStorageAdapter", () => {
  let storage: PostgresStorageAdapter;

  beforeEach(async () => {
    storage = new PostgresStorageAdapter({ pool: createMockPgPool() as never });
    await storage.initialize();
  });

  it("stores and retrieves a memory", async () => {
    const mem = await storage.store({ actorId: "a", content: "test" });
    expect(mem.id).toMatch(/^mem_/);
    const retrieved = await storage.get(mem.id);
    expect(retrieved?.content).toBe("test");
  });

  it("returns null for missing memory", async () => {
    expect(await storage.get("nonexistent")).toBeNull();
  });

  it("deletes a memory", async () => {
    const mem = await storage.store({ actorId: "a", content: "test" });
    await storage.delete(mem.id);
    expect(await storage.get(mem.id)).toBeNull();
  });

  it("counts by actorId", async () => {
    await storage.store({ actorId: "a", content: "1" });
    await storage.store({ actorId: "a", content: "2" });
    await storage.store({ actorId: "b", content: "3" });
    expect(await storage.count({ actorId: "a" })).toBe(2);
  });

  it("retrieves by strategy", async () => {
    await storage.store({ actorId: "a", content: "low", importance: 0.1 });
    await storage.store({ actorId: "a", content: "high", importance: 0.9 });
    const results = await storage.retrieve({ actorId: "a", strategy: "important", limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("high");
  });

  it("filters expired memories", async () => {
    const past = new Date(Date.now() - 10000);
    await storage.store({ actorId: "a", content: "expired", expiresAt: past });
    await storage.store({ actorId: "a", content: "valid" });
    expect(await storage.count({ actorId: "a" })).toBe(1);
  });

  it("stores batch", async () => {
    const results = await storage.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);
    expect(results).toHaveLength(2);
  });

  it("touch updates timestamp", async () => {
    const mem = await storage.store({ actorId: "a", content: "test" });
    await storage.touch(mem.id);
    const retrieved = await storage.get(mem.id);
    expect(retrieved).not.toBeNull();
  });

  it("deleteMany removes multiple", async () => {
    const m1 = await storage.store({ actorId: "a", content: "1" });
    const m2 = await storage.store({ actorId: "a", content: "2" });
    const deleted = await storage.deleteMany([m1.id, m2.id]);
    expect(deleted).toBe(2);
  });

  it("throws for invalid table name", () => {
    expect(
      () => new PostgresStorageAdapter({ pool: createMockPgPool() as never, tableName: "bad;drop" })
    ).toThrow(/Invalid table name/);
  });
});
