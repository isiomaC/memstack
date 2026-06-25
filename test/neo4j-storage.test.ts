import { describe, it, expect } from "vitest";
import { Neo4jStorageAdapter } from "../src/adapters/storage/neo4j.js";

function createMockNeo4jDriver() {
  const nodes = new Map<string, Record<string, unknown>>();
  let insertOrder = 0;

  function createSession() {
    return {
      async run(query: string, params?: Record<string, unknown>) {
        if (query.includes("MERGE")) {
          const id = params?.id as string;
          const existing = nodes.get(id);
          if (existing) {
            Object.assign(existing, params?.updateProps ?? {});
          } else {
            const entry = {
              id,
              _order: insertOrder++,
              ...(params?.props ?? {}) as Record<string, unknown>,
            };
            nodes.set(id, entry);
          }
          return { records: [] };
        }
        if (query.includes("UNWIND") && query.includes("DETACH DELETE")) {
          const ids = params?.ids as string[];
          let deleted = 0;
          for (const id of ids) {
            if (nodes.has(id)) { nodes.delete(id); deleted++; }
          }
          return { records: [{ get: (k: string) => k === "deleted" ? deleted : 0, toObject: () => ({ deleted }) }] };
        }
        if (query.includes("DETACH DELETE")) {
          const id = params?.id as string;
          if (!nodes.has(id)) throw new Error("not found");
          nodes.delete(id);
          return { records: [] };
        }
        if ((query.includes("{id: $id}") || query.includes("m.id = $id")) && !query.includes("DETACH DELETE")) {
          const id = params?.id as string;
          const node = nodes.get(id);
          return { records: node ? [{ get: () => node, toObject: () => node }] : [] };
        }
        if (query.includes("count(m)")) {
          const conditions = [];
          const p = params ?? {};
          if (p.actorId) conditions.push((n: Record<string, unknown>) => n.actorId === p.actorId);
          if (p.memoryType) conditions.push((n: Record<string, unknown>) => n.memoryType === p.memoryType);
          if (p.minImportance !== undefined) conditions.push((n: Record<string, unknown>) => (n.importance as number) >= (p.minImportance as number));
          const matching = conditions.length > 0
            ? Array.from(nodes.values()).filter(n => conditions.every(c => c(n)))
            : Array.from(nodes.values());
          const count = matching.length;
          return { records: [{ get: (k: string) => k === "count" ? count : 0, toObject: () => ({ count }) }] };
        }
        if (query.includes("m.actorId")) {
          const actorId = params?.actorId as string;
          let results = Array.from(nodes.values()).filter(n => n.actorId === actorId);
          if (query.includes("ORDER BY m.createdAt DESC")) {
            results.sort((a, b) => (b.createdAt as string).localeCompare(a.createdAt as string));
          }
          if (query.includes("ORDER BY m.importance DESC") && !query.includes("m.createdAt DESC")) {
            results.sort((a, b) => (b.importance as number) - (a.importance as number));
          }
          if (query.includes("ORDER BY m.importance DESC, m.createdAt DESC")) {
            results.sort((a, b) =>
              (b.importance as number) - (a.importance as number) ||
              (b.createdAt as string).localeCompare(a.createdAt as string)
            );
          }
          if (query.includes("LIMIT")) {
            const limitMatch = query.match(/LIMIT\s+(\d+)/);
            const limit = limitMatch ? parseInt(limitMatch[1], 10) : 100;
            results = results.slice(0, limit);
          }
          return { records: results.map(n => ({ get: () => n, toObject: () => n })) };
        }
        if (query.includes("vector.queryNodes")) {
          const actorId = params?.actorId as string;
          const results = Array.from(nodes.values()).filter(n => n.actorId === actorId);
          return { records: results.map(n => ({ get: (_k: string) => n, toObject: () => n })) };
        }
        return { records: [] };
      },
      async close() {},
    };
  }

  return {
    session() { return createSession(); },
    async close() {},
  };
}

describe("Neo4jStorageAdapter", () => {
  it("stores and retrieves a memory", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
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
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    const mem = await adapter.store({ actorId: "a", content: "test" });
    await adapter.delete(mem.id);
    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("throws notFound when deleting missing memory", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    await expect(adapter.delete("nonexistent")).rejects.toThrow("not found");
  });

  it("deleteMany removes multiple memories", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    const m1 = await adapter.store({ actorId: "a", content: "1" });
    const m2 = await adapter.store({ actorId: "a", content: "2" });
    const m3 = await adapter.store({ actorId: "a", content: "3" });

    const deleted = await adapter.deleteMany([m1.id, m3.id]);
    expect(deleted).toBe(2);
    expect(await adapter.count({ actorId: "a" })).toBe(1);
  });

  it("counts by actorId", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "b", content: "3" });

    expect(await adapter.count({ actorId: "a" })).toBe(2);
    expect(await adapter.count({ actorId: "b" })).toBe(1);
    expect(await adapter.count()).toBe(3);
  });

  it("retrieves by recent strategy", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "old", importance: 0.1 });
    await new Promise(r => setTimeout(r, 10));
    await adapter.store({ actorId: "a", content: "recent", importance: 0.1 });

    const results = await adapter.retrieve({
      actorId: "a",
      strategy: "recent",
      limit: 2,
    });

    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("recent");
  });

  it("retrieves by important strategy", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "old", importance: 0.1 });
    await adapter.store({ actorId: "a", content: "important", importance: 0.9 });

    const results = await adapter.retrieve({
      actorId: "a",
      strategy: "important",
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("important");
  });

  it("retrieves by semantic strategy with embedding", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "memory one", embedding: [0.1, 0.2] });
    await adapter.store({ actorId: "a", content: "memory two", embedding: [0.3, 0.4] });

    const results = await adapter.retrieve(
      { actorId: "a", strategy: "semantic", limit: 2 },
      [0.1, 0.2]
    );

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.content)).toContain("memory one");
    expect(results.map((r) => r.content)).toContain("memory two");
  });

  it("stores batch", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await adapter.count()).toBe(2);
  });

  it("stores memory with full metadata", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    const mem = await adapter.store({
      actorId: "a",
      content: "rich memory",
      importance: 0.8,
      emotionalValence: 0.5,
      tags: ["test", "neo4j"],
      sourceId: "src-1",
      metadata: { key: "value" },
      embedding: [0.1, 0.2, 0.3],
    });

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.importance).toBe(0.8);
    expect(retrieved!.emotionalValence).toBe(0.5);
    expect(retrieved!.tags).toEqual(["test", "neo4j"]);
    expect(retrieved!.sourceId).toBe("src-1");
    expect(retrieved!.metadata).toEqual({ key: "value" });
    expect(retrieved!.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("graphQuery escape hatch runs arbitrary cypher", async () => {
    const driver = createMockNeo4jDriver();
    const adapter = new Neo4jStorageAdapter({ driver });
    await adapter.initialize();

    await adapter.store({ actorId: "a", content: "find me", tags: ["target"] });

    const results = await adapter.graphQuery(
      "MATCH (m:Memory) WHERE m.actorId = $actorId RETURN m",
      { actorId: "a" }
    );

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("find me");
    expect(results[0].tags).toContain("target");
  });
});
