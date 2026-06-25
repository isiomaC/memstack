import { describe, it, expect } from "vitest";
import { ChromaStorageAdapter } from "../src/adapters/storage/chroma.js";

function createMockChromaCollection() {
  const data: { id: string; metadata: Record<string, unknown>; document: string; embedding: number[] }[] = [];
  return {
    async add(opts: { ids: string[]; metadatas?: Record<string, unknown>[]; documents?: string[]; embeddings?: number[][] }) {
      for (let i = 0; i < opts.ids.length; i++) {
        data.push({ id: opts.ids[i], metadata: opts.metadatas?.[i] ?? {}, document: opts.documents?.[i] ?? "", embedding: opts.embeddings?.[i] ?? [] });
      }
    },
    async get(opts: { ids?: string[]; where?: Record<string, unknown>; limit?: number }) {
      let results = data;
      if (opts.ids) results = results.filter(r => opts.ids!.includes(r.id));
      if (opts.where?.actorId) results = results.filter(r => r.metadata.actorId === (opts.where!.actorId as { $eq: string }).$eq);
      if (opts.limit) results = results.slice(0, opts.limit);
      return { ids: results.map(r => r.id), metadatas: results.map(r => r.metadata), documents: results.map(r => r.document), embeddings: results.map(r => r.embedding) };
    },
    async query() { return { ids: [[]], metadatas: [[]], documents: [[]], distances: [[]] }; },
    async delete(opts: { ids?: string[] }) {
      if (opts.ids) for (const id of opts.ids) { const idx = data.findIndex(r => r.id === id); if (idx !== -1) data.splice(idx, 1); }
    },
    async modify() {},
    async count() { return data.length; },
    async peek(limit?: number) {
      const results = data.slice(0, limit ?? 10);
      return { ids: results.map(r => r.id), metadatas: results.map(r => r.metadata), documents: results.map(r => r.document), embeddings: results.map(r => r.embedding) };
    },
  };
}

describe("ChromaStorageAdapter", () => {
  it("stores and retrieves a memory", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

    const mem = await adapter.store({
      actorId: "actor_1",
      content: "Hello from Chroma",
      importance: 0.8,
    });

    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("actor_1");
    expect(mem.content).toBe("Hello from Chroma");
    expect(mem.importance).toBe(0.8);
    expect(mem.createdAt).toBeInstanceOf(Date);

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Hello from Chroma");
    expect(retrieved!.importance).toBe(0.8);
  });

  it("returns null for missing memory", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

    const mem = await adapter.store({ actorId: "a", content: "to delete" });
    await adapter.delete(mem.id);

    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("deleteMany removes multiple memories and returns count", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

    const m1 = await adapter.store({ actorId: "a", content: "one" });
    const m2 = await adapter.store({ actorId: "a", content: "two" });
    const m3 = await adapter.store({ actorId: "a", content: "three" });

    const count = await adapter.deleteMany([m1.id, m2.id]);
    expect(count).toBe(2);

    expect(await adapter.get(m1.id)).toBeNull();
    expect(await adapter.get(m2.id)).toBeNull();
    expect(await adapter.get(m3.id)).not.toBeNull();
  });

  it("counts total and by actorId", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "b", content: "3" });

    expect(await adapter.count()).toBe(3);
    expect(await adapter.count({ actorId: "a" })).toBe(2);
    expect(await adapter.count({ actorId: "b" })).toBe(1);
  });

  it("retrieves by importance strategy", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

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
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

    const m1 = await adapter.store({ actorId: "a", content: "first" });
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await adapter.store({ actorId: "a", content: "second" });

    const results = await adapter.retrieve({
      actorId: "a",
      strategy: "recent",
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(m2.id);
  });

  it("retrieves by query text filter", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

    await adapter.store({ actorId: "a", content: "dragon attack" });
    await adapter.store({ actorId: "a", content: "goblin ambush" });

    const results = await adapter.retrieve({
      actorId: "a",
      query: "dragon",
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("dragon attack");
  });

  it("stores batch", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await adapter.count()).toBe(2);
  });

  it("round-trips metadata and tags", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });

    const mem = await adapter.store({
      actorId: "a",
      content: "tagged memory",
      tags: ["urgent", "combat"],
      metadata: { location: "forest", hp: 42 },
    });

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tags).toEqual(["urgent", "combat"]);
    expect(retrieved!.metadata).toEqual({ location: "forest", hp: 42 });
  });

  it("close is a no-op", async () => {
    const collection = createMockChromaCollection();
    const adapter = new ChromaStorageAdapter({ collection: collection as never });
    await adapter.close();
  });
});
