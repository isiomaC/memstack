/**
 * End-to-end tests for QdrantStorageAdapter against a real Qdrant instance.
 *
 * Requires: docker compose up -d qdrant
 * Env: QDRANT_PORT (default 6333), QDRANT_VECTOR_SIZE (default 16), QDRANT_COLLECTION (default memstack-e2e)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantStorageAdapter } from "../src/adapters/storage/qdrant.js";

const QDRANT_PORT = parseInt(process.env.QDRANT_PORT ?? "6333", 10);
const QDRANT_VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE ?? "16", 10);
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION ?? "memstack-e2e";

describe("QdrantStorageAdapter E2E", () => {
  let client: QdrantClient;
  let adapter: QdrantStorageAdapter;

  beforeAll(async () => {
    client = new QdrantClient({ host: "localhost", port: QDRANT_PORT });
    adapter = new QdrantStorageAdapter({
      client: client as never,
      collectionName: QDRANT_COLLECTION,
      vectorSize: QDRANT_VECTOR_SIZE,
    });
    await adapter.initialize();
  });

  afterAll(async () => {
    try {
      await client.deleteCollection(QDRANT_COLLECTION);
    } catch {
      // collection may not exist
    }
    await adapter.close();
  });

  it("1. UUID mapping — store memory, verify string ID returned, get finds it via _idToQdrant map", async () => {
    const mem = await adapter.store({
      actorId: "qd-e2e-actor",
      content: "UUID mapping test",
      importance: 0.8,
    });
    expect(mem.id).toMatch(/^mem_/);
    expect(typeof mem.id).toBe("string");

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("UUID mapping test");
    expect(retrieved!.id).toBe(mem.id);
    expect(retrieved!.importance).toBe(0.8);
  });

  it("2. filtered search — store 3 with different actorId, retrieve with actorId filter returns only matching", async () => {
    await adapter.store({ actorId: "qd-filter-a", content: "A's memory" });
    await adapter.store({ actorId: "qd-filter-a", content: "A's second" });
    await adapter.store({ actorId: "qd-filter-b", content: "B's memory" });

    const results = await adapter.retrieve({ actorId: "qd-filter-a", limit: 10 });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.actorId === "qd-filter-a")).toBe(true);
    expect(results.some((r) => r.content === "A's memory")).toBe(true);
    expect(results.some((r) => r.content === "A's second")).toBe(true);
  });

  it("3. vector search — store with embedding, retrieve semantic matches correct memory", async () => {
    const actorId = "qd-vector";
    const vecSize = QDRANT_VECTOR_SIZE;

    const embRelevant = Array.from({ length: vecSize }, (_, i) => (i === 0 ? 1.0 : 0.0));
    const embIrrelevant = Array.from({ length: vecSize }, (_, i) => (i === vecSize - 1 ? 1.0 : 0.0));

    await adapter.store({ actorId, content: "relevant memory", embedding: embRelevant });
    await adapter.store({ actorId, content: "irrelevant memory", embedding: embIrrelevant });

    const queryVec = Array.from({ length: vecSize }, (_, i) => (i === 0 ? 0.9 : 0.0));

    const results = await adapter.retrieve(
      { actorId, strategy: "semantic", limit: 1 },
      queryVec
    );
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("relevant memory");
  });

  it("4. payload integrity — store with tags+metadata+importance, get returns all fields intact", async () => {
    const mem = await adapter.store({
      actorId: "qd-payload",
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

  it("5. batch store — storeBatch 3, verify all retrievable", async () => {
    const results = await adapter.storeBatch([
      { actorId: "qd-batch", content: "batch-1" },
      { actorId: "qd-batch", content: "batch-2" },
      { actorId: "qd-batch", content: "batch-3" },
    ]);
    expect(results).toHaveLength(3);

    const count = await adapter.count({ actorId: "qd-batch" });
    expect(count).toBe(3);

    for (const mem of results) {
      const retrieved = await adapter.get(mem.id);
      expect(retrieved).not.toBeNull();
    }
  });

  it("6. deleteMany — store 3, deleteMany 2, verify count=1", async () => {
    const actorId = "qd-deletemany";
    const m1 = await adapter.store({ actorId, content: "del-1" });
    const m2 = await adapter.store({ actorId, content: "del-2" });
    const m3 = await adapter.store({ actorId, content: "del-3" });

    const deleted = await adapter.deleteMany([m1.id, m2.id]);
    expect(deleted).toBe(2);

    const count = await adapter.count({ actorId });
    expect(count).toBe(1);
    expect(await adapter.get(m3.id)).not.toBeNull();
    expect(await adapter.get(m1.id)).toBeNull();
  });

  it("7. count with filters — actorId, memoryType, minImportance", async () => {
    const actorId = "qd-count";
    await adapter.store({
      actorId,
      content: "interaction-a",
      memoryType: "interaction",
      importance: 0.3,
    });
    await adapter.store({
      actorId,
      content: "observation-a",
      memoryType: "observation",
      importance: 0.7,
    });
    await adapter.store({
      actorId: "qd-count-other",
      content: "other",
      memoryType: "interaction",
      importance: 0.5,
    });

    expect(await adapter.count({ actorId })).toBe(2);
    expect(await adapter.count({ actorId, memoryType: "observation" })).toBe(1);
    expect(await adapter.count({ actorId, minImportance: 0.5 })).toBe(1);
  });

  it("8. initialize — verify collection creation works", async () => {
    const freshClient = new QdrantClient({ host: "localhost", port: QDRANT_PORT });
    const freshAdapter = new QdrantStorageAdapter({
      client: freshClient as never,
      collectionName: "e2e_qdrant_init",
      vectorSize: QDRANT_VECTOR_SIZE,
    });

    // Initialize should create the collection if it doesn't exist
    await freshAdapter.initialize();

    const mem = await freshAdapter.store({
      actorId: "qd-init",
      content: "init test",
    });
    expect(mem.id).toMatch(/^mem_/);

    const retrieved = await freshAdapter.get(mem.id);
    expect(retrieved).not.toBeNull();

    // Clean up
    try { await freshClient.deleteCollection("e2e_qdrant_init"); } catch { /* ok */ }
    await freshAdapter.close();
  });
});
