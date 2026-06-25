import { describe, it, expect } from "vitest";
import { QdrantStorageAdapter } from "../src/adapters/storage/qdrant.js";

function createMockQdrant() {
  const points = new Map<string, { id: string; vector: number[]; payload: Record<string, unknown> }>();

  function matchValue(payloadValue: unknown, filterValue: unknown): boolean {
    if (Array.isArray(payloadValue) && typeof filterValue === "string") {
      return payloadValue.includes(filterValue);
    }
    return payloadValue === filterValue;
  }

  function matchAny(payloadValue: unknown, anyValues: unknown[]): boolean {
    if (Array.isArray(payloadValue)) {
      return payloadValue.some((v) => anyValues.includes(v));
    }
    return anyValues.includes(payloadValue);
  }

  function passesFilter(point: { id: string; vector: number[]; payload: Record<string, unknown> }, filter?: { must: unknown[] }): boolean {
    if (!filter || !filter.must || filter.must.length === 0) return true;
    for (const condition of filter.must) {
      const cond = condition as Record<string, unknown>;
      const key = cond.key as string;
      const match = cond.match as Record<string, unknown> | undefined;
      const range = cond.range as Record<string, unknown> | undefined;

      const payloadValue = point.payload[key];

      if (match) {
        if ("value" in match) {
          if (!matchValue(payloadValue, match.value)) return false;
        } else if ("any" in match) {
          if (!matchAny(payloadValue, match.any as unknown[])) return false;
        }
      }

      if (range) {
        const numVal = payloadValue as number;
        if (range.gte !== undefined && numVal < (range.gte as number)) return false;
        if (range.lte !== undefined && numVal > (range.lte as number)) return false;
      }
    }
    return true;
  }

  return {
    async createCollection() {
      return {};
    },
    async getCollection() {
      return { exists: true };
    },
    async upsert(_name: string, opts: { points: { id: string; vector: number[]; payload: Record<string, unknown> }[] }) {
      for (const p of opts.points) {
        points.set(p.id, { id: p.id, vector: p.vector, payload: p.payload });
      }
      return {};
    },
    async retrieve(_name: string, opts: { ids: string[] }) {
      return opts.ids.map((id) => points.get(id)).filter(Boolean);
    },
    async search(_name: string, opts: { vector: number[]; limit: number; filter?: { must: unknown[] } }) {
      const all = Array.from(points.values());
      const filtered = all.filter((p) => passesFilter(p, opts.filter));
      const scored = filtered.map((p) => {
        let dot = 0;
        for (let i = 0; i < opts.vector.length && i < p.vector.length; i++) {
          dot += opts.vector[i] * p.vector[i];
        }
        return { point: p, score: dot };
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, opts.limit).map((s) => s.point);
    },
    async delete(_name: string, opts: { points: string[] }) {
      for (const id of opts.points) {
        points.delete(id);
      }
      return {};
    },
    async count(_name: string, opts?: { filter?: { must: unknown[] } }) {
      if (!opts?.filter) return { count: points.size };
      const filtered = Array.from(points.values()).filter((p) => passesFilter(p, opts.filter!));
      return { count: filtered.length };
    },
  };
}

describe("QdrantStorageAdapter", () => {
  it("constructs with defaults", () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });
    expect(adapter).toBeDefined();
  });

  it("constructs with custom collectionName and vectorSize", () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({
      client,
      collectionName: "custom",
      vectorSize: 768,
    });
    expect(adapter).toBeDefined();
  });

  it("initializes and creates collection if not exists", async () => {
    let created = false;
    let collectionName = "";
    const client = {
      ...createMockQdrant(),
      async getCollection(_name: string) {
        if (created) return { exists: true };
        throw new Error("not found");
      },
      async createCollection(name: string, _config: unknown) {
        created = true;
        collectionName = name;
        return {};
      },
    };
    const adapter = new QdrantStorageAdapter({ client });
    await adapter.initialize();
    expect(created).toBe(true);
    expect(collectionName).toBe("memstack");
  });

  it("stores and retrieves a memory", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    const mem = await adapter.store({
      actorId: "actor_1",
      content: "Hello world",
    });

    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("actor_1");
    expect(mem.content).toBe("Hello world");
    expect(mem.memoryType).toBe("interaction");
    expect(mem.createdAt).toBeInstanceOf(Date);

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Hello world");
    expect(retrieved!.actorId).toBe("actor_1");
  });

  it("returns null for missing memory", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    const mem = await adapter.store({ actorId: "a", content: "test" });
    await adapter.delete(mem.id);

    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("throws notFound when deleting non-existent memory", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await expect(adapter.delete("nonexistent")).rejects.toThrow("not found");
  });

  it("stores batch", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await adapter.count()).toBe(2);
  });

  it("counts by actorId", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "b", content: "3" });

    expect(await adapter.count({ actorId: "a" })).toBe(2);
    expect(await adapter.count({ actorId: "b" })).toBe(1);
    expect(await adapter.count()).toBe(3);
  });

  it("counts by memoryType", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await adapter.store({ actorId: "a", content: "1", memoryType: "interaction" });
    await adapter.store({ actorId: "a", content: "2", memoryType: "fact" });

    expect(await adapter.count({ memoryType: "interaction" })).toBe(1);
    expect(await adapter.count({ memoryType: "fact" })).toBe(1);
  });

  it("counts by minImportance", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await adapter.store({ actorId: "a", content: "low", importance: 0.2 });
    await adapter.store({ actorId: "a", content: "high", importance: 0.8 });

    expect(await adapter.count({ minImportance: 0.5 })).toBe(1);
  });

  it("retrieves by semantic strategy with embedding", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client, vectorSize: 3 });

    await adapter.store({
      actorId: "a",
      content: "relevant",
      embedding: [1.0, 0.0, 0.0],
    });
    await adapter.store({
      actorId: "a",
      content: "irrelevant",
      embedding: [0.0, 0.0, 1.0],
    });

    const results = await adapter.retrieve(
      { actorId: "a", strategy: "semantic", limit: 1 },
      [1.0, 0.0, 0.0]
    );

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("relevant");
  });

  it("retrieves by important strategy", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await adapter.store({ actorId: "a", content: "low", importance: 0.1 });
    await adapter.store({ actorId: "a", content: "high", importance: 0.9 });

    const results = await adapter.retrieve({
      actorId: "a",
      strategy: "important",
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("high");
  });

  it("retrieves by recent strategy", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    const first = await adapter.store({ actorId: "a", content: "old" });
    await new Promise((r) => setTimeout(r, 10));
    const second = await adapter.store({ actorId: "a", content: "new" });

    const results = await adapter.retrieve({
      actorId: "a",
      strategy: "recent",
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("new");
    expect(results[0].id).toBe(second.id);
  });

  it("retrieves with memoryType filter", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await adapter.store({ actorId: "a", content: "interaction", memoryType: "interaction" });
    await adapter.store({ actorId: "a", content: "fact", memoryType: "fact" });

    const results = await adapter.retrieve({
      actorId: "a",
      memoryTypes: ["fact"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("fact");
  });

  it("retrieves with tags filter", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await adapter.store({ actorId: "a", content: "tagged", tags: ["important"] });
    await adapter.store({ actorId: "a", content: "untagged", tags: ["casual"] });

    const results = await adapter.retrieve({
      actorId: "a",
      tags: ["important"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("tagged");
  });

  it("respects limit on retrieve", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "a", content: "3" });

    const results = await adapter.retrieve({ actorId: "a", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("deleteMany removes multiple memories", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    const m1 = await adapter.store({ actorId: "a", content: "1" });
    const m2 = await adapter.store({ actorId: "a", content: "2" });
    const m3 = await adapter.store({ actorId: "a", content: "3" });

    const deleted = await adapter.deleteMany([m1.id, m2.id]);
    expect(deleted).toBe(2);
    expect(await adapter.get(m1.id)).toBeNull();
    expect(await adapter.get(m2.id)).toBeNull();
    expect(await adapter.get(m3.id)).not.toBeNull();
  });

  it("deleteMany with non-existent IDs returns only existing count", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    const m1 = await adapter.store({ actorId: "a", content: "1" });
    const deleted = await adapter.deleteMany([m1.id, "nonexistent"]);
    expect(deleted).toBe(1);
  });

  it("handles pre-assigned ID on store", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    const mem = await adapter.store({
      actorId: "a",
      content: "custom-id",
      id: "mem_custom",
    });

    expect(mem.id).toBe("mem_custom");
    const retrieved = await adapter.get("mem_custom");
    expect(retrieved).not.toBeNull();
  });

  it("close is a no-op", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await adapter.store({ actorId: "a", content: "test" });
    await adapter.close();
    expect(await adapter.count()).toBe(1);
  });

  it("retrieves across actors with no actorId filter", async () => {
    const client = createMockQdrant();
    const adapter = new QdrantStorageAdapter({ client });

    await adapter.store({ actorId: "a", content: "from a" });
    await adapter.store({ actorId: "b", content: "from b" });

    const results = await adapter.retrieve({ limit: 10 });
    expect(results).toHaveLength(2);
  });
});
