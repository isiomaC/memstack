import { describe, it, expect } from "vitest";
import { MongoDBStorageAdapter } from "../src/adapters/storage/mongodb.js";

function createMockMongoCollection() {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    async insertOne(doc: Record<string, unknown>) {
      docs.set(doc._id as string, doc);
      return { insertedId: doc._id as string };
    },
    async findOne(filter: Record<string, unknown>) {
      if (filter._id) return docs.get(filter._id as string) ?? null;
      return null;
    },
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
      const id = filter._id as string;
      if (update["$set"]) {
        const existing = docs.get(id);
        if (existing) { docs.set(id, { ...existing, ...update["$set"] }); return { upsertedId: undefined }; }
        const newDoc = { _id: id, ...update["$set"] };
        docs.set(id, newDoc);
        return { upsertedId: id };
      }
      return {};
    },
    async deleteOne(filter: Record<string, unknown>) {
      const id = filter._id as string;
      const had = docs.has(id);
      docs.delete(id);
      return { deletedCount: had ? 1 : 0 };
    },
    async deleteMany(filter: Record<string, unknown>) {
      if (filter._id?.$in) {
        let count = 0;
        for (const id of filter._id.$in as string[]) { if (docs.delete(id)) count++; }
        return { deletedCount: count };
      }
      return { deletedCount: 0 };
    },
    find(filter: Record<string, unknown>) {
      let results = Array.from(docs.values());
      if (filter.actorId) results = results.filter(r => r.actorId === filter.actorId);
      return {
        sort(_s: Record<string, number>) {
          return {
            limit(n: number) {
              return { toArray: async () => results.slice(0, n) };
            },
          };
        },
      };
    },
    async countDocuments() { return docs.size; },
    aggregate(_pipeline: Record<string, unknown>[]) {
      return { toArray: async () => Array.from(docs.values()) };
    },
  };
}

describe("MongoDBStorageAdapter", () => {
  it("constructs with a collection", () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });
    expect(adapter).toBeInstanceOf(MongoDBStorageAdapter);
  });

  it("generates IDs with mem_ prefix", () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });
    const id = adapter.generateId();
    expect(id).toMatch(/^mem_/);
  });

  it("stores and retrieves a memory", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

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

  it("stores a memory with embedding", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    const embedding = [0.1, 0.2, 0.3];
    const mem = await adapter.store({
      actorId: "npc_1",
      content: "Vector memory",
      embedding,
    });

    expect(mem.embedding).toEqual(embedding);

    const retrieved = await adapter.get(mem.id);
    expect(retrieved!.embedding).toEqual(embedding);
  });

  it("returns null for missing memory", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a single memory", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    const mem = await adapter.store({ actorId: "a", content: "test" });
    await adapter.delete(mem.id);
    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("throws notFound when deleting nonexistent memory", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    await expect(adapter.delete("nonexistent")).rejects.toThrow("Memory not found");
  });

  it("deletes many memories", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    const m1 = await adapter.store({ actorId: "a", content: "one" });
    const m2 = await adapter.store({ actorId: "a", content: "two" });
    const m3 = await adapter.store({ actorId: "a", content: "three" });

    const count = await adapter.deleteMany([m1.id, m2.id]);
    expect(count).toBe(2);

    expect(await adapter.get(m1.id)).toBeNull();
    expect(await adapter.get(m2.id)).toBeNull();
    expect(await adapter.get(m3.id)).not.toBeNull();
  });

  it("counts all documents", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "b", content: "3" });

    const count = await adapter.count();
    expect(count).toBe(3);
  });

  it("retrieves by actorId filter", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    await adapter.store({ actorId: "a", content: "one" });
    await adapter.store({ actorId: "a", content: "two" });
    await adapter.store({ actorId: "b", content: "three" });

    const results = await adapter.retrieve({ actorId: "a" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.actorId === "a")).toBe(true);
  });

  it("retrieves with semantic strategy using aggregate (vector search)", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    await adapter.store({
      actorId: "a",
      content: "one",
      embedding: [1, 0, 0],
    });
    await adapter.store({
      actorId: "a",
      content: "two",
      embedding: [0, 1, 0],
    });

    const results = await adapter.retrieve(
      { actorId: "a", strategy: "semantic", limit: 1 },
      [1, 0, 0]
    );

    expect(results.length).toBeGreaterThan(0);
  });

  it("falls back to standard retrieve when semantic strategy has no embedding", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    await adapter.store({ actorId: "a", content: "test" });

    const results = await adapter.retrieve({
      actorId: "a",
      strategy: "semantic",
    });

    expect(results).toHaveLength(1);
  });

  it("stores batch", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await adapter.count()).toBe(2);
  });

  it("initialize does not throw", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    await expect(adapter.initialize()).resolves.toBeUndefined();
  });

  it("close does not throw", async () => {
    const mock = createMockMongoCollection();
    const adapter = new MongoDBStorageAdapter({ collection: mock });

    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
