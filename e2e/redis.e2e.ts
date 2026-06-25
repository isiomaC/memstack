/**
 * End-to-end tests for RedisStorageAdapter against a real Redis instance.
 *
 * Requires: docker compose up -d redis
 * Env: REDIS_PORT (default 6380)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { RedisStorageAdapter } from "../src/adapters/storage/redis.js";

const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? "6380", 10);

describe("RedisStorageAdapter E2E", () => {
  let redis: Redis;
  let adapter: RedisStorageAdapter;

  beforeAll(async () => {
    redis = new Redis({ host: "localhost", port: REDIS_PORT, lazyConnect: true });
    await redis.connect();
    adapter = new RedisStorageAdapter({ redis: redis as never, keyPrefix: "e2e_redis" });
    await adapter.initialize();
  });

  afterAll(async () => {
    const keys = await redis.keys("e2e_redis:*");
    if (keys.length > 0) {
      await redis.del(keys);
    }
    await adapter.close();
    await redis.quit();
  });

  it("1. actor isolation — store memory for actor A and B, retrieve for A only returns A's", async () => {
    await adapter.store({ actorId: "actor-a", content: "A's memory" });
    await adapter.store({ actorId: "actor-b", content: "B's memory" });

    const resultsA = await adapter.retrieve({ actorId: "actor-a", limit: 10 });
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].content).toBe("A's memory");

    const resultsB = await adapter.retrieve({ actorId: "actor-b", limit: 10 });
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].content).toBe("B's memory");
  });

  it("2. SMEMBERS stability — store memory, kill process (simulated), new adapter finds it", async () => {
    // Use a separate Redis client to simulate a new connection
    const redis2 = new Redis({ host: "localhost", port: REDIS_PORT, lazyConnect: true });
    await redis2.connect();
    const adapter2 = new RedisStorageAdapter({
      redis: redis2 as never,
      keyPrefix: "e2e_redis_smem",
    });
    await adapter2.initialize();

    const mem = await adapter2.store({
      actorId: "smem-actor",
      content: "persistent memory",
      importance: 0.9,
    });

    // Close the "old" connection
    await adapter2.close();
    await redis2.quit();

    // Open a "new" connection and adapter
    const redis3 = new Redis({ host: "localhost", port: REDIS_PORT, lazyConnect: true });
    await redis3.connect();
    const adapter3 = new RedisStorageAdapter({
      redis: redis3 as never,
      keyPrefix: "e2e_redis_smem",
    });
    await adapter3.initialize();

    const retrieved = await adapter3.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("persistent memory");
    expect(retrieved!.importance).toBe(0.9);

    // Clean up
    await redis3.del(`e2e_redis_smem:m:${mem.id}`);
    await redis3.del("e2e_redis_smem:a:smem-actor");
    await redis3.del("e2e_redis_smem:actors");
    await adapter3.close();
    await redis3.quit();
  });

  it("3. touch — store memory, touch it, verify get still returns it", async () => {
    const mem = await adapter.store({
      actorId: "redis-touch",
      content: "Touch me",
    });
    await adapter.touch(mem.id);
    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(mem.id);
  });

  it("4. tags filter — store with tag urgent, retrieve with tags:['urgent']", async () => {
    const actorId = "redis-tags";
    await adapter.store({ actorId, content: "urgent issue", tags: ["urgent"] });
    await adapter.store({ actorId, content: "normal note", tags: ["normal"] });

    const results = await adapter.retrieve({ actorId, tags: ["urgent"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("urgent issue");
  });

  it("5. batch store — storeBatch 3 memories, verify count=3", async () => {
    const actorId = "redis-batch";
    await adapter.storeBatch([
      { actorId, content: "batch-1" },
      { actorId, content: "batch-2" },
      { actorId, content: "batch-3" },
    ]);
    const count = await adapter.count({ actorId });
    expect(count).toBe(3);
  });

  it("6. deleteMany — store 3, deleteMany 2, verify count=1", async () => {
    const actorId = "redis-deletemany";
    const m1 = await adapter.store({ actorId, content: "del-1" });
    const m2 = await adapter.store({ actorId, content: "del-2" });
    const m3 = await adapter.store({ actorId, content: "del-3" });

    const deleted = await adapter.deleteMany([m1.id, m2.id]);
    expect(deleted).toBe(2);

    const count = await adapter.count({ actorId });
    expect(count).toBe(1);
    expect(await adapter.get(m3.id)).not.toBeNull();
  });

  it("7. importance sort — store 3 with different importance, retrieve important strategy", async () => {
    const actorId = "redis-importance";
    await adapter.store({ actorId, content: "low", importance: 0.1 });
    await adapter.store({ actorId, content: "high", importance: 0.9 });
    await adapter.store({ actorId, content: "medium", importance: 0.5 });

    const results = await adapter.retrieve({
      actorId,
      strategy: "important",
      limit: 3,
    });
    expect(results).toHaveLength(3);
    expect(results[0].content).toBe("high");
    expect(results[2].content).toBe("low");
  });

  it("8. recent sort — store 3, retrieve recent strategy", async () => {
    const actorId = "redis-recent";
    await adapter.store({ actorId, content: "first" });
    await new Promise((r) => setTimeout(r, 50));
    await adapter.store({ actorId, content: "second" });

    const results = await adapter.retrieve({
      actorId,
      strategy: "recent",
      limit: 2,
    });
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("second");
  });

  it("9. memoryType filter — store interaction + summary, retrieve memoryTypes:['summary']", async () => {
    const actorId = "redis-mtype";
    await adapter.store({
      actorId,
      content: "interaction msg",
      memoryType: "interaction",
    });
    await adapter.store({
      actorId,
      content: "summary note",
      memoryType: "summary",
    });

    const results = await adapter.retrieve({
      actorId,
      memoryTypes: ["summary"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("summary note");
  });

  it("10. count with filters — actorId, memoryType, minImportance", async () => {
    const actorId = "redis-count";
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
      actorId: "redis-count-other",
      content: "other",
      memoryType: "interaction",
      importance: 0.5,
    });

    expect(await adapter.count({ actorId })).toBe(2);
    expect(await adapter.count({ actorId, memoryType: "observation" })).toBe(1);
    expect(await adapter.count({ actorId, minImportance: 0.5 })).toBe(1);
  });
});
