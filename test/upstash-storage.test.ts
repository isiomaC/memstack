import { describe, it, expect } from "vitest";
import { UpstashStorageAdapter } from "../src/adapters/storage/upstash.js";

function createMockUpstashRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  function ensureSet(key: string): Set<string> {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key)!;
  }

  return {
    async set(k: string, v: string) { store.set(k, v); return "OK"; },
    async get(k: string) { return store.get(k) ?? null; },
    async del(k: string) { store.delete(k); return 1; },
    async keys(pattern: string) { return Array.from(store.keys()).filter(k => k.startsWith(pattern.replace("*", ""))); },
    async mget(...keys: string[]) { return keys.map(k => store.get(k) ?? null); },
    async sadd(key: string, ...members: string[]) {
      const s = ensureSet(key);
      for (const m of members) s.add(m);
      return members.length;
    },
    async srem(key: string, ...members: string[]) {
      const s = ensureSet(key);
      let count = 0;
      for (const m of members) { if (s.delete(m)) count++; }
      return count;
    },
    async smembers(key: string) {
      return Array.from(ensureSet(key));
    },
  };
}

function createMockUpstashVector() {
  const vectors = new Map<string, { vector: number[]; metadata: Record<string, unknown> }>();
  return {
    async upsert(vs: { id: string; vector: number[]; metadata?: Record<string, unknown> }[]) {
      for (const v of vs) vectors.set(v.id, { vector: v.vector, metadata: v.metadata ?? {} });
      return "OK";
    },
    async query(opts: { filter?: string }) {
      let results = Array.from(vectors.entries());
      if (opts.filter) {
        const match = opts.filter.match(/actorId\s*=\s*"([^"]+)"/);
        if (match) results = results.filter(([, v]) => v.metadata.actorId === match[1]);
      }
      return results.map(([id, v]) => ({ id, score: 1, metadata: v.metadata }));
    },
    async fetch(ids: string[]) { return ids.map(id => vectors.has(id) ? { id, ...vectors.get(id)! } : null).filter(Boolean) as { id: string; vector?: number[]; metadata?: Record<string, unknown> }[]; },
    async delete(ids: string[]) { for (const id of ids) vectors.delete(id); return "OK"; },
    async info() { return { vectorCount: vectors.size, dimension: 1536 }; },
  };
}

describe("UpstashStorageAdapter - Redis mode", () => {
  it("stores and retrieves a memory", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();

    const mem = await adapter.store({ actorId: "a", content: "hello" });
    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("a");
    expect(mem.content).toBe("hello");
    expect(mem.createdAt).toBeInstanceOf(Date);

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("hello");
  });

  it("returns null for missing memory", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();
    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();
    const mem = await adapter.store({ actorId: "a", content: "test" });
    await adapter.delete(mem.id);
    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("throws notFound when deleting missing memory", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();
    await expect(adapter.delete("no-such-id")).rejects.toThrow("Memory not found");
  });

  it("retrieves by recent strategy", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();

    const m1 = await adapter.store({ actorId: "a", content: "old", importance: 0.3 });
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await adapter.store({ actorId: "a", content: "new", importance: 0.3 });

    const results = await adapter.retrieve({ actorId: "a", strategy: "recent", limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(m2.id);
  });

  it("retrieves by important strategy", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();

    await adapter.store({ actorId: "a", content: "low", importance: 0.2 });
    await adapter.store({ actorId: "a", content: "high", importance: 0.9 });

    const results = await adapter.retrieve({ actorId: "a", strategy: "important", limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("high");
  });

  it("retrieves by query text", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();

    await adapter.store({ actorId: "a", content: "goblin attack" });
    await adapter.store({ actorId: "a", content: "dragon sighting" });

    const results = await adapter.retrieve({ actorId: "a", query: "goblin" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("goblin attack");
  });

  it("counts memories", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();

    await adapter.store({ actorId: "a", content: "one" });
    await adapter.store({ actorId: "a", content: "two" });
    await adapter.store({ actorId: "b", content: "three" });

    expect(await adapter.count()).toBe(3);
    expect(await adapter.count({ actorId: "a" })).toBe(2);
    expect(await adapter.count({ actorId: "b" })).toBe(1);
  });

  it("stores batch", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();

    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await adapter.count()).toBe(2);
  });

  it("deleteMany removes multiple memories", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();

    const m1 = await adapter.store({ actorId: "a", content: "one" });
    const m2 = await adapter.store({ actorId: "a", content: "two" });

    const count = await adapter.deleteMany([m1.id, m2.id, "nonexistent"]);
    expect(count).toBe(2);
    expect(await adapter.count()).toBe(0);
  });

  it("close is a no-op", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("uses custom keyPrefix", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token", keyPrefix: "custom:" });
    const mockRedis = createMockUpstashRedis();
    (adapter as any).redis = mockRedis;

    const mem = await adapter.store({ actorId: "a", content: "test" });
    const raw = await mockRedis.get(`custom:${mem.id}`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.content).toBe("test");
  });

  it("filters expired memories from retrieve", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();

    const pastDate = new Date(Date.now() - 86400000);
    const futureDate = new Date(Date.now() + 86400000);

    await adapter.store({ actorId: "a", content: "expired", expiresAt: pastDate });
    await adapter.store({ actorId: "a", content: "valid", expiresAt: futureDate });

    const results = await adapter.retrieve({ actorId: "a" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("valid");
  });

  it("returns empty array for empty retrieve", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "redis", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).redis = createMockUpstashRedis();

    const results = await adapter.retrieve({ actorId: "nonexistent" });
    expect(results).toEqual([]);
  });
});

describe("UpstashStorageAdapter - Vector mode", () => {
  it("stores and retrieves a memory", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();

    const mem = await adapter.store({ actorId: "a", content: "hello vector" });
    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("a");

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("hello vector");
  });

  it("returns null for missing memory", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();
    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();

    const mem = await adapter.store({ actorId: "a", content: "test" });
    await adapter.delete(mem.id);
    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("performs semantic query", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();

    await adapter.store({ actorId: "a", content: "goblin battle", embedding: [0.1, 0.2] });
    await adapter.store({ actorId: "a", content: "dragon lore", embedding: [0.9, 0.8] });
    await adapter.store({ actorId: "b", content: "other actor", embedding: [0.5, 0.5] });

    const results = await adapter.retrieve(
      { actorId: "a", strategy: "semantic", limit: 2 },
      [0.1, 0.2]
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((m) => m.actorId === "a")).toBe(true);
  });

  it("counts memories", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();

    await adapter.store({ actorId: "a", content: "one" });
    await adapter.store({ actorId: "a", content: "two" });
    await adapter.store({ actorId: "b", content: "three" });

    expect(await adapter.count()).toBe(3);
    expect(await adapter.count({ actorId: "a" })).toBe(2);
  });

  it("deleteMany removes multiple memories", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();

    const m1 = await adapter.store({ actorId: "a", content: "one" });
    const m2 = await adapter.store({ actorId: "a", content: "two" });

    const count = await adapter.deleteMany([m1.id, m2.id, "nonexistent"]);
    expect(count).toBe(2);
    expect(await adapter.count()).toBe(0);
  });

  it("stores batch", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();

    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await adapter.count()).toBe(2);
  });

  it("falls back to importance+recency sort for non-semantic strategies", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();

    await adapter.store({ actorId: "a", content: "low", importance: 0.2 });
    await adapter.store({ actorId: "a", content: "high", importance: 0.9 });

    const results = await adapter.retrieve({ actorId: "a", strategy: "important", limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("high");
  });

  it("filters by memoryType in non-semantic retrieve", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();

    await adapter.store({ actorId: "a", content: "interaction mem", memoryType: "interaction" });
    await adapter.store({ actorId: "a", content: "observation mem", memoryType: "observation" });

    const results = await adapter.retrieve({ actorId: "a", memoryTypes: ["observation"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("observation mem");
  });

  it("round-trips metadata through vector store", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    (adapter as any).vector = createMockUpstashVector();

    const mem = await adapter.store({
      actorId: "a",
      content: "meta test",
      importance: 0.7,
      tags: ["combat", "goblin"],
      metadata: { gameId: "game-123" },
      sourceId: "src-1",
    });

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.importance).toBe(0.7);
    expect(retrieved!.tags).toEqual(["combat", "goblin"]);
    expect(retrieved!.metadata).toEqual({ gameId: "game-123" });
    expect(retrieved!.sourceId).toBe("src-1");
  });

  it("close is a no-op", async () => {
    const adapter = new UpstashStorageAdapter({ mode: "vector", url: "https://example.upstash.io", token: "test-token" });
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

describe("UpstashStorageAdapter - construction errors", () => {
  it("throws for invalid mode", () => {
    expect(() => {
      new UpstashStorageAdapter({ mode: "invalid" as any, url: "x", token: "x" });
    }).toThrow("Invalid mode");
  });

  it("throws for missing url", () => {
    expect(() => {
      new UpstashStorageAdapter({ mode: "redis", url: "", token: "x" });
    }).toThrow("url and token are required");
  });

  it("throws for missing token", () => {
    expect(() => {
      new UpstashStorageAdapter({ mode: "redis", url: "x", token: "" });
    }).toThrow("url and token are required");
  });
});
