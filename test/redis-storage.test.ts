import { describe, it, expect, beforeEach } from "vitest";
import { RedisStorageAdapter } from "../src/adapters/storage/redis.js";

function createMockRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  return {
    async set(k: string, v: string) {
      store.set(k, v);
      return "OK";
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async del(k: string | string[]) {
      const keys = Array.isArray(k) ? k : [k];
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
      }
      return count;
    },
    async mget(...keys: string[]) {
      return keys.map((k) => store.get(k) ?? null);
    },
    async sadd(k: string, ...members: string[]) {
      let set = sets.get(k);
      if (!set) {
        set = new Set();
        sets.set(k, set);
      }
      for (const m of members) set.add(m);
      return set.size;
    },
    async srem(k: string, ...members: string[]) {
      const set = sets.get(k);
      if (!set) return 0;
      let count = 0;
      for (const m of members) {
        if (set.delete(m)) count++;
      }
      return count;
    },
    async smembers(k: string) {
      return Array.from(sets.get(k) ?? []);
    },
  };
}

describe("RedisStorageAdapter", () => {
  let storage: RedisStorageAdapter;

  beforeEach(async () => {
    storage = new RedisStorageAdapter({ redis: createMockRedis() as never });
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

  it("retrieves by tag filter", async () => {
    await storage.store({ actorId: "a", content: "bug", tags: ["bug"] });
    await storage.store({ actorId: "a", content: "feature", tags: ["feature"] });
    const results = await storage.retrieve({ actorId: "a", tags: ["bug"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("bug");
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
});
