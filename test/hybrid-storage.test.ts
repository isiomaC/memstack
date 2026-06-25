import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../src/adapters/storage/memory.js";
import { HybridStorageAdapter } from "../src/adapters/storage/hybrid.js";

describe("HybridStorageAdapter", () => {
  it("store writes to both (cache and durable)", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    const mem = await hybrid.store({ actorId: "a", content: "hello" });

    const fromCache = await cache.get(mem.id);
    const fromDurable = await durable.get(mem.id);

    expect(fromCache).not.toBeNull();
    expect(fromCache!.content).toBe("hello");
    expect(fromDurable).not.toBeNull();
    expect(fromDurable!.content).toBe("hello");
  });

  it("get reads from cache first", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    const mem = await hybrid.store({ actorId: "a", content: "cached" });

    const result = await hybrid.get(mem.id);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("cached");
  });

  it("get falls back to durable when cache misses, and repopulates cache", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    const mem = await durable.store({ actorId: "a", content: "durable-only" });

    const result = await hybrid.get(mem.id);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("durable-only");

    const fromCache = await cache.get(mem.id);
    expect(fromCache).not.toBeNull();
    expect(fromCache!.content).toBe("durable-only");
  });

  it("retrieve from cache returns cached results", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    await hybrid.store({ actorId: "a", content: "from hybrid" });

    const results = await hybrid.retrieve({ actorId: "a", limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("from hybrid");
  });

  it("retrieve falls back to durable when cache empty and repopulates cache", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    await durable.store({ actorId: "a", content: "durable data" });

    const results = await hybrid.retrieve({ actorId: "a", limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("durable data");

    const cached = await cache.retrieve({ actorId: "a", limit: 10 });
    expect(cached).toHaveLength(1);
    expect(cached[0].content).toBe("durable data");
  });

  it("delete removes from both", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    const mem = await hybrid.store({ actorId: "a", content: "delete me" });

    await hybrid.delete(mem.id);

    expect(await cache.get(mem.id)).toBeNull();
    expect(await durable.get(mem.id)).toBeNull();
  });

  it("delete throws if durable throws notFound", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    await expect(hybrid.delete("nonexistent")).rejects.toThrow();
  });

  it("deleteMany removes from both and returns durable count", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    const m1 = await hybrid.store({ actorId: "a", content: "one" });
    const m2 = await hybrid.store({ actorId: "a", content: "two" });

    const count = await hybrid.deleteMany([m1.id, m2.id]);

    expect(count).toBe(2);
    expect(await cache.get(m1.id)).toBeNull();
    expect(await cache.get(m2.id)).toBeNull();
    expect(await durable.get(m1.id)).toBeNull();
    expect(await durable.get(m2.id)).toBeNull();
  });

  it("count uses durable", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    await durable.store({ actorId: "a", content: "d1" });
    await cache.store({ actorId: "a", content: "c1" });
    await cache.store({ actorId: "a", content: "c2" });

    const count = await hybrid.count();
    expect(count).toBe(1);
  });

  it("writeBoth: false still writes to durable, skips cache", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable, writeBoth: false });

    const mem = await hybrid.store({ actorId: "a", content: "durable only" });

    expect(await cache.get(mem.id)).toBeNull();
    expect(await durable.get(mem.id)).not.toBeNull();
  });

  it("readFromCache: false bypasses cache entirely for get", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable, readFromCache: false });

    const mem = await durable.store({ actorId: "a", content: "direct" });

    const result = await hybrid.get(mem.id);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("direct");
  });

  it("readFromCache: false bypasses cache entirely for retrieve", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable, readFromCache: false });

    await durable.store({ actorId: "a", content: "direct retrieve" });

    const results = await hybrid.retrieve({ actorId: "a", limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("direct retrieve");
  });

  it("syncOnInit loads durable into cache on initialize", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable, syncOnInit: true });

    await durable.store({ actorId: "a", content: "pre-sync" });
    await durable.store({ actorId: "a", content: "pre-sync 2" });

    await hybrid.initialize();

    const cached = await cache.retrieve({ actorId: "a", limit: 10 });
    expect(cached).toHaveLength(2);
    expect(cached.map((m) => m.content).sort()).toEqual(["pre-sync", "pre-sync 2"]);
  });

  it("initialize works without syncOnInit", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    await durable.store({ actorId: "a", content: "no-sync" });
    await hybrid.initialize();

    const cached = await cache.retrieve({ actorId: "a", limit: 10 });
    expect(cached).toHaveLength(0);
  });

  it("touch forwards to durable", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    const mem = await hybrid.store({ actorId: "a", content: "touch test" });

    const before = (await durable.get(mem.id))!.createdAt;

    await new Promise((r) => setTimeout(r, 5));
    await hybrid.touch(mem.id);

    const after = await durable.get(mem.id);
    expect(after).not.toBeNull();
  });

  it("close closes both", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    await hybrid.store({ actorId: "a", content: "closing" });
    expect(await durable.count()).toBe(1);
    expect(await cache.count()).toBe(1);

    await hybrid.close();

    expect(await durable.count()).toBe(0);
    expect(await cache.count()).toBe(0);
  });

  it("storeBatch writes to both", async () => {
    const durable = new InMemoryStorageAdapter();
    const cache = new InMemoryStorageAdapter();
    const hybrid = new HybridStorageAdapter({ cache, durable });

    const results = await hybrid.storeBatch([
      { actorId: "a", content: "batch 1" },
      { actorId: "a", content: "batch 2" },
    ]);

    expect(results).toHaveLength(2);
    expect(await durable.count()).toBe(2);
    expect(await cache.count()).toBe(2);
  });
});
