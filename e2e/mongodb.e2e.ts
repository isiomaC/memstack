/**
 * End-to-end tests for MongoDBStorageAdapter against a real MongoDB instance.
 *
 * Requires: docker compose up -d mongodb
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MongoClient } from "mongodb";
import { MongoDBStorageAdapter } from "../src/adapters/storage/mongodb.js";

describe("MongoDBStorageAdapter E2E", () => {
  let client: MongoClient;
  let adapter: MongoDBStorageAdapter;
  let collName: string;

  beforeAll(async () => {
    client = new MongoClient("mongodb://localhost:27017");
    await client.connect();
    const db = client.db("memstack_e2e");
    collName = `e2e_${Date.now().toString(36)}`;
    const collection = db.collection(collName);
    adapter = new MongoDBStorageAdapter({ collection: collection as never });
    await adapter.initialize();
  });

  afterAll(async () => {
    try {
      const db = client.db("memstack_e2e");
      await db.dropCollection(collName);
    } catch {
      // collection may not exist
    }
    await adapter.close();
    await client.close();
  });

  it("1. store creates memory with mem_ prefix", async () => {
    const mem = await adapter.store({
      actorId: "mongo-e2e",
      content: "MongoDB E2E test",
      importance: 0.9,
      tags: ["mongo", "e2e"],
      metadata: { source: "e2e" },
    });
    expect(mem.id).toMatch(/^mem_/);
    expect(mem.content).toBe("MongoDB E2E test");
    expect(mem.importance).toBe(0.9);
    expect(mem.tags).toEqual(expect.arrayContaining(["mongo", "e2e"]));
    expect(mem.metadata).toMatchObject({ source: "e2e" });
  });

  it("2. get returns correct memory", async () => {
    const mem = await adapter.store({
      actorId: "mongo-e2e-get",
      content: "Get test content",
      importance: 0.7,
    });
    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(mem.id);
    expect(retrieved!.content).toBe("Get test content");
    expect(retrieved!.importance).toBe(0.7);
  });

  it("3. get returns null for nonexistent id", async () => {
    const retrieved = await adapter.get("mem_nonexistent_12345");
    expect(retrieved).toBeNull();
  });

  it("4. important strategy returns highest importance first", async () => {
    const actorId = "mongo-important";
    await adapter.store({ actorId, content: "low", importance: 0.2 });
    await adapter.store({ actorId, content: "high", importance: 0.9 });
    await adapter.store({ actorId, content: "medium", importance: 0.5 });

    const results = await adapter.retrieve({
      actorId,
      strategy: "important",
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe(0.9);
    expect(results[0].content).toBe("high");
  });

  it("5. recent strategy returns most recent first", async () => {
    const actorId = "mongo-recent";
    const m1 = await adapter.store({ actorId, content: "first" });
    await new Promise((r) => setTimeout(r, 50));
    const m2 = await adapter.store({ actorId, content: "second" });

    const results = await adapter.retrieve({
      actorId,
      strategy: "recent",
      limit: 10,
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].content).toBe("second");
  });

  it("6. count by actorId", async () => {
    const actorId = "mongo-count";
    await adapter.store({ actorId, content: "one" });
    await adapter.store({ actorId, content: "two" });
    await adapter.store({ actorId, content: "three" });

    const count = await adapter.count({ actorId });
    expect(count).toBe(3);
  });

  it("7. count with filters — memoryType and minImportance", async () => {
    const actorId = "mongo-count-filter";
    await adapter.store({
      actorId,
      content: "interaction-low",
      memoryType: "interaction",
      importance: 0.2,
    });
    await adapter.store({
      actorId,
      content: "observation-high",
      memoryType: "observation",
      importance: 0.8,
    });
    await adapter.store({
      actorId: "mongo-count-other",
      content: "other",
      memoryType: "interaction",
      importance: 0.5,
    });

    expect(await adapter.count({ actorId })).toBe(2);
    expect(await adapter.count({ actorId, memoryType: "observation" })).toBe(1);
    expect(await adapter.count({ actorId, minImportance: 0.5 })).toBe(1);
  });

  it("8. storeBatch stores multiple memories", async () => {
    const results = await adapter.storeBatch([
      { actorId: "mongo-batch", content: "batch-1" },
      { actorId: "mongo-batch", content: "batch-2" },
      { actorId: "mongo-batch", content: "batch-3" },
    ]);
    expect(results).toHaveLength(3);

    const count = await adapter.count({ actorId: "mongo-batch" });
    expect(count).toBe(3);

    for (const mem of results) {
      const retrieved = await adapter.get(mem.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(mem.id);
    }
  });

  it("9. deleteMany removes correct number of memories", async () => {
    const actorId = "mongo-deletemany";
    const m1 = await adapter.store({ actorId, content: "del-1" });
    const m2 = await adapter.store({ actorId, content: "del-2" });
    const m3 = await adapter.store({ actorId, content: "del-3" });

    const deleted = await adapter.deleteMany([m1.id, m2.id]);
    expect(deleted).toBe(2);

    const count = await adapter.count({ actorId });
    expect(count).toBe(1);
    expect(await adapter.get(m3.id)).not.toBeNull();
    expect(await adapter.get(m1.id)).toBeNull();
    expect(await adapter.get(m2.id)).toBeNull();
  });

  it("10. delete removes single memory", async () => {
    const mem = await adapter.store({
      actorId: "mongo-delete",
      content: "Delete me",
    });
    await adapter.delete(mem.id);
    const retrieved = await adapter.get(mem.id);
    expect(retrieved).toBeNull();
  });

  it("11. payload integrity — all fields preserved round-trip", async () => {
    const mem = await adapter.store({
      actorId: "mongo-payload",
      content: "Full payload test",
      importance: 0.75,
      emotionalValence: 0.3,
      tags: ["e2e", "payload"],
      sourceId: "src-42",
      metadata: { custom: "data", nested: { a: 1 } },
    });

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.importance).toBe(0.75);
    expect(retrieved!.emotionalValence).toBe(0.3);
    expect(retrieved!.tags).toEqual(expect.arrayContaining(["e2e", "payload"]));
    expect(retrieved!.sourceId).toBe("src-42");
    expect(retrieved!.metadata).toMatchObject({ custom: "data" });
    expect((retrieved!.metadata as Record<string, unknown>).nested).toEqual({ a: 1 });
  });

  it("12. tag filter in retrieve", async () => {
    const actorId = "mongo-tags";
    await adapter.store({ actorId, content: "critical bug", tags: ["critical"] });
    await adapter.store({ actorId, content: "minor issue", tags: ["minor"] });

    const results = await adapter.retrieve({
      actorId,
      tags: ["critical"],
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("critical bug");
  });

  it("13. memoryType filter in retrieve", async () => {
    const actorId = "mongo-mtype";
    await adapter.store({
      actorId,
      content: "interaction event",
      memoryType: "interaction",
    });
    await adapter.store({
      actorId,
      content: "observed event",
      memoryType: "observation",
    });

    const results = await adapter.retrieve({
      actorId,
      memoryTypes: ["observation"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("observed event");
  });

  it("14. expired memory — get returns null", async () => {
    const past = new Date(Date.now() - 60_000);
    const mem = await adapter.store({
      actorId: "mongo-expired",
      content: "expired content",
      expiresAt: past,
    });

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).toBeNull();
  });
});
