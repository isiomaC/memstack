import { describe, it, expect } from "vitest";
import { PineconeStorageAdapter } from "../src/adapters/storage/pinecone.js";
import type { PineconeIndex } from "../src/adapters/storage/pinecone.js";

interface VectorEntry {
  values: number[];
  metadata: Record<string, unknown>;
}

function createMockPineconeIndex(): PineconeIndex {
  const vectors = new Map<string, VectorEntry>();

  function matchFilter(meta: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
    if (!filter || Object.keys(filter).length === 0) return true;
    const actorFilter = filter.actorId as { $eq?: string } | undefined;
    if (actorFilter?.$eq && meta.actorId !== actorFilter.$eq) return false;
    const memFilter = filter.memoryType as { $eq?: string; $in?: string[] } | undefined;
    if (memFilter?.$eq && meta.memoryType !== memFilter.$eq) return false;
    if (memFilter?.$in && !memFilter.$in.includes(meta.memoryType as string)) return false;
    const tagsIn = filter.tags as { $in?: string[] } | undefined;
    if (tagsIn?.$in) {
      const memTags = (meta.tags as string[]) ?? [];
      if (!memTags.some((t) => tagsIn.$in!.includes(t))) return false;
    }
    return true;
  }

  function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
  }

  return {
    async upsert(vs: { id: string; values: number[]; metadata?: Record<string, unknown> }[]) {
      for (const v of vs) {
        vectors.set(v.id, { values: v.values, metadata: v.metadata ?? {} });
      }
    },
    async query(opts: {
      vector: number[];
      topK: number;
      filter?: Record<string, unknown>;
      includeMetadata?: boolean;
      includeValues?: boolean;
    }) {
      const matches: {
        id: string;
        score: number;
        metadata?: Record<string, unknown>;
        values?: number[];
      }[] = [];
      for (const [id, entry] of vectors) {
        if (!matchFilter(entry.metadata, opts.filter)) continue;
        const score = cosineSimilarity(opts.vector, entry.values);
        matches.push({
          id,
          score,
          metadata: opts.includeMetadata ? entry.metadata : undefined,
          values: opts.includeValues ? entry.values : undefined,
        });
      }
      matches.sort((a, b) => b.score - a.score);
      return { matches: matches.slice(0, opts.topK) };
    },
    async fetch(ids: string[]) {
      const records: Record<string, { id: string; metadata?: Record<string, unknown>; values?: number[] }> = {};
      for (const id of ids) {
        const v = vectors.get(id);
        if (v) records[id] = { id, metadata: v.metadata, values: v.values };
      }
      return { records };
    },
    async deleteOne(id: string) {
      vectors.delete(id);
    },
    async deleteMany(ids: string[]) {
      for (const id of ids) vectors.delete(id);
    },
    async describeIndexStats() {
      let recordCount = 0;
      const actorNamespaces = new Map<string, number>();
      for (const [, entry] of vectors) {
        recordCount++;
        const actorId = entry.metadata.actorId as string;
        if (actorId) {
          actorNamespaces.set(actorId, (actorNamespaces.get(actorId) ?? 0) + 1);
        }
      }
      return { namespaces: { memstack: { recordCount } } };
    },
  };
}

describe("PineconeStorageAdapter", () => {
  it("constructs with required config", () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });
    expect(adapter).toBeDefined();
  });

  it("constructs with optional namespace and dimension", () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index, namespace: "test", dimension: 768 });
    expect(adapter).toBeDefined();
  });

  it("generates IDs with mem_ prefix", () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });
    const id = adapter.generateId();
    expect(id).toMatch(/^mem_[a-z0-9]+_[a-f0-9]{8}$/);
  });

  it("store and get a memory", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    const mem = await adapter.store({
      actorId: "actor_1",
      content: "Hello world",
      embedding: new Array(1536).fill(0.1),
    });

    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("actor_1");
    expect(mem.content).toBe("Hello world");
    expect(mem.createdAt).toBeInstanceOf(Date);

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Hello world");
    expect(retrieved!.actorId).toBe("actor_1");
  });

  it("returns null for missing memory", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    const mem = await adapter.store({ actorId: "a", content: "test" });
    await adapter.delete(mem.id);

    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("throws notFound when deleting nonexistent memory", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await expect(adapter.delete("nonexistent")).rejects.toThrow("Memory not found");
  });

  it("deleteMany removes multiple and returns count", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    const a = await adapter.store({ actorId: "x", content: "a" });
    const b = await adapter.store({ actorId: "x", content: "b" });
    const c = await adapter.store({ actorId: "x", content: "c" });

    const count = await adapter.deleteMany([a.id, b.id, "nonexistent"]);
    expect(count).toBe(2);

    expect(await adapter.get(a.id)).toBeNull();
    expect(await adapter.get(b.id)).toBeNull();
    expect(await adapter.get(c.id)).not.toBeNull();
  });

  it("deleteMany returns 0 for empty array", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    const count = await adapter.deleteMany([]);
    expect(count).toBe(0);
  });

  it("count returns total records", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "b", content: "3" });

    expect(await adapter.count()).toBe(3);
  });

  it("count filters by actorId", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "b", content: "3" });

    expect(await adapter.count({ actorId: "a" })).toBe(2);
    expect(await adapter.count({ actorId: "b" })).toBe(1);
  });

  it("count filters by memoryType and minImportance", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await adapter.store({ actorId: "a", content: "1", memoryType: "interaction", importance: 0.3 });
    await adapter.store({ actorId: "a", content: "2", memoryType: "fact", importance: 0.8 });

    expect(await adapter.count({ memoryType: "fact" })).toBe(1);
    expect(await adapter.count({ minImportance: 0.5 })).toBe(1);
  });

  it("semantic retrieve uses vector query", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await adapter.store({
      actorId: "actor_1",
      content: "The goblin attacked the village",
      embedding: new Array(1536).fill(0).map((_, i) => (i === 0 ? 1.0 : 0)),
    });
    await adapter.store({
      actorId: "actor_1",
      content: "A peaceful meadow",
      embedding: new Array(1536).fill(0).map((_, i) => (i === 1 ? 1.0 : 0)),
    });

    const embedding = new Array(1536).fill(0);
    embedding[0] = 1.0;

    const results = await adapter.retrieve(
      { actorId: "actor_1", strategy: "semantic", limit: 2 },
      embedding,
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toBe("The goblin attacked the village");
  });

  it("recent retrieve sorts by recency", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await adapter.store({
      actorId: "actor_1",
      content: "old memory",
      importance: 0.1,
    });

    await new Promise((r) => setTimeout(r, 10));

    await adapter.store({
      actorId: "actor_1",
      content: "recent memory",
      importance: 0.1,
    });

    const results = await adapter.retrieve({
      actorId: "actor_1",
      strategy: "recent",
      limit: 2,
    });

    expect(results.length).toBe(2);
    expect(results[0].content).toBe("recent memory");
  });

  it("important retrieve sorts by importance", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await adapter.store({ actorId: "actor_1", content: "low", importance: 0.1 });
    await adapter.store({ actorId: "actor_1", content: "high", importance: 0.9 });

    const results = await adapter.retrieve({
      actorId: "actor_1",
      strategy: "important",
      limit: 2,
    });

    expect(results[0].content).toBe("high");
  });

  it("retrieve filters by memoryType", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await adapter.store({ actorId: "a", content: "fact 1", memoryType: "fact" });
    await adapter.store({ actorId: "a", content: "interaction 1", memoryType: "interaction" });

    const results = await adapter.retrieve({
      actorId: "a",
      memoryTypes: ["fact"],
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toBe("fact 1");
  });

  it("retrieve filters by tags", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await adapter.store({ actorId: "a", content: "combat log", tags: ["combat"] });
    await adapter.store({ actorId: "a", content: "dialog log", tags: ["dialog"] });

    const results = await adapter.retrieve({
      actorId: "a",
      tags: ["combat"],
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toBe("combat log");
  });

  it("retrieve filters by text query", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await adapter.store({ actorId: "a", content: "The dragon appeared" });
    await adapter.store({ actorId: "a", content: "A knight arrived" });

    const results = await adapter.retrieve({
      actorId: "a",
      query: "dragon",
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toBe("The dragon appeared");
  });

  it("storeBatch stores multiple memories", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await adapter.count()).toBe(2);
  });

  it("initialize is a no-op", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await expect(adapter.initialize()).resolves.toBeUndefined();
  });

  it("close is a no-op", async () => {
    const index = createMockPineconeIndex();
    const adapter = new PineconeStorageAdapter({ index });

    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
