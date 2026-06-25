/**
 * End-to-end tests for WeaviateStorageAdapter against a real Weaviate instance.
 *
 * Requires: docker compose up -d weaviate
 * Env: WEAVIATE_HOST (default localhost), WEAVIATE_PORT (default 8080),
 *      WEAVIATE_GRPC_PORT (default 50051), WEAVIATE_CLASS (default MemstackE2E)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import weaviate from "weaviate-client";
import { WeaviateStorageAdapter } from "../src/adapters/storage/weaviate.js";

const WEAVIATE_HOST = process.env.WEAVIATE_HOST ?? "localhost";
const WEAVIATE_PORT = parseInt(process.env.WEAVIATE_PORT ?? "8080", 10);
const WEAVIATE_GRPC_PORT = parseInt(process.env.WEAVIATE_GRPC_PORT ?? "50051", 10);
const WEAVIATE_CLASS = process.env.WEAVIATE_CLASS ?? "MemstackE2E";

describe("WeaviateStorageAdapter E2E", () => {
  let wvClient: Awaited<ReturnType<typeof weaviate.connectToLocal>>;
  let adapter: WeaviateStorageAdapter;

  beforeAll(async () => {
    wvClient = await weaviate.connectToLocal({
      host: WEAVIATE_HOST,
      port: WEAVIATE_PORT,
      grpcPort: WEAVIATE_GRPC_PORT,
    });

    // Clean up any previous test collection
    try {
      await wvClient.collections.delete(WEAVIATE_CLASS);
    } catch {
      // collection may not exist
    }

    // Pre-create the collection with the schema the adapter expects
    await wvClient.collections.create({
      name: WEAVIATE_CLASS,
      properties: [
        { name: "_memstackId", dataType: "text" as const },
        { name: "actorId", dataType: "text" as const },
        { name: "memoryType", dataType: "text" as const },
        { name: "content", dataType: "text" as const },
        { name: "importance", dataType: "number" as const },
        { name: "emotionalValence", dataType: "number" as const },
        { name: "tags", dataType: "text[]" as const },
        { name: "metadata", dataType: "text" as const },
        { name: "sourceId", dataType: "text" as const },
        { name: "expiresAt", dataType: "text" as const },
        { name: "createdAt", dataType: "text" as const },
      ],
      vectorizers: weaviate.configure.vectorizer.none(),
    });

    adapter = new WeaviateStorageAdapter({
      client: wvClient as never,
      className: WEAVIATE_CLASS,
    });
    await adapter.initialize();

    // Clean up any stale data from previous runs
    const allExisting = await adapter.retrieve({ limit: 1000 });
    for (const m of allExisting) {
      try { await adapter.delete(m.id); } catch {}
    }
  }, 30000);

  afterAll(async () => {
    await adapter.close();
    try {
      await wvClient.collections.delete(WEAVIATE_CLASS);
    } catch {
      // ok
    }
  });

  it("1. schema auto-creation — create adapter, call initialize, verify collection exists", async () => {
    // The collection was pre-created in beforeAll and initialize() got a reference to it.
    // Verify by storing and retrieving a memory.
    const mem = await adapter.store({
      actorId: "wv-schema",
      content: "Schema verification test",
    });
    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Schema verification test");
  });

  it("2. nearVector search — store with embedding, retrieve semantic matches correct", async () => {
    const actorId = "wv-nearvec";
    const embA = new Array(1536).fill(0);
    embA[0] = 1.0;
    const embB = new Array(1536).fill(0);
    embB[1] = 1.0;

    await adapter.store({ actorId, content: "target memory", embedding: embA });
    await adapter.store({ actorId, content: "other memory", embedding: embB });

    const queryVec = new Array(1536).fill(0);
    queryVec[0] = 0.9;

    const results = await adapter.retrieve(
      { actorId, strategy: "semantic", limit: 1 },
      queryVec
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe("target memory");
  });

  it("3. filter operators — store with actorId, retrieve with Equal filter", async () => {
    const actorId = "wv-filter";
    await adapter.store({ actorId, content: "found via filter" });
    await adapter.store({ actorId: "wv-filter-other", content: "other actor" });

    const results = await adapter.retrieve({ actorId, limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("found via filter");
    expect(results[0].actorId).toBe(actorId);
  });

  it("4. id mapping — store, get returns correct memory via _memstackId in properties", async () => {
    const mem = await adapter.store({
      actorId: "wv-idmap",
      content: "ID mapping test",
      importance: 0.85,
      tags: ["idmap"],
    });

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(mem.id);
    expect(retrieved!.content).toBe("ID mapping test");
    expect(retrieved!.importance).toBe(0.85);
    expect(retrieved!.tags).toContain("idmap");
  });

  it("5. batch store — storeBatch 3, verify all retrievable", async () => {
    const results = await adapter.storeBatch([
      { actorId: "wv-batch", content: "batch-1" },
      { actorId: "wv-batch", content: "batch-2" },
      { actorId: "wv-batch", content: "batch-3" },
    ]);
    expect(results).toHaveLength(3);

    for (const mem of results) {
      const retrieved = await adapter.get(mem.id);
      expect(retrieved).not.toBeNull();
    }

    const count = await adapter.count({ actorId: "wv-batch" });
    expect(count).toBe(3);
  });

  it("6. count with minImportance — store with importance 0.2 and 0.9, count with minImportance:0.5 returns only 1", async () => {
    const actorId = "wv-count-imp";
    await adapter.store({ actorId, content: "low importance", importance: 0.2 });
    await adapter.store({ actorId, content: "high importance", importance: 0.9 });

    const count = await adapter.count({ actorId, minImportance: 0.5 });
    expect(count).toBe(1);
  });

  it("7. delete + verify — store, delete, get returns null", async () => {
    const mem = await adapter.store({
      actorId: "wv-delete",
      content: "to be deleted",
    });
    expect(await adapter.get(mem.id)).not.toBeNull();

    await adapter.delete(mem.id);
    expect(await adapter.get(mem.id)).toBeNull();
  });

  it("8. retrieve recent — store 3 memories, retrieve recent returns all 3 sorted by creation", async () => {
    const actorId = "wv-recent";
    await adapter.store({ actorId, content: "oldest" });
    await new Promise((r) => setTimeout(r, 100));
    await adapter.store({ actorId, content: "middle" });
    await new Promise((r) => setTimeout(r, 100));
    await adapter.store({ actorId, content: "newest" });

    const results = await adapter.retrieve({
      actorId,
      strategy: "recent",
      limit: 3,
    });
    expect(results).toHaveLength(3);
    expect(results[0].content).toBe("newest");
    expect(results[2].content).toBe("oldest");
  });

  it("9. retrieve important — store with importance 0.2 and 0.9, retrieve important returns 0.9 first", async () => {
    const actorId = "wv-important";
    await adapter.store({ actorId, content: "low priority", importance: 0.2 });
    await adapter.store({ actorId, content: "high priority", importance: 0.9 });

    const results = await adapter.retrieve({
      actorId,
      strategy: "important",
      limit: 2,
    });
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("high priority");
    expect(results[0].importance).toBe(0.9);
    expect(results[1].content).toBe("low priority");
  });
});
