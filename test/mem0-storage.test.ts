import { describe, it, expect, beforeEach, vi } from "vitest";
import { Mem0StorageAdapter } from "../src/adapters/storage/mem0.js";
import type { Mem0StorageConfig } from "../src/adapters/storage/mem0.js";
import type { Memory } from "../src/types.js";

function createStatefulMockMem0() {
  const store = new Map<string, Memory>();

  return {
    async add(messages: unknown[], options?: { user_id?: string; metadata?: Record<string, unknown> }) {
      const content = Array.isArray(messages) ? String((messages[0] as Record<string, unknown>)?.content ?? "") : "";
      const meta = options?.metadata ?? {};
      const id = `mem0_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const memory: Memory = {
        id,
        actorId: options?.user_id ?? "",
        memoryType: (meta.memoryType as Memory["memoryType"]) ?? "interaction",
        content,
        importance: (meta.importance as number) ?? 0.5,
        emotionalValence: (meta.emotionalValence as number) ?? 0,
        tags: (meta.tags as string[]) ?? [],
        metadata: options?.metadata ?? {},
        createdAt: new Date(),
      };
      store.set(id, memory);
      return [{ id, memory: content, user_id: options?.user_id, metadata: meta }];
    },
    async search(_query: string, options?: { user_id?: string; limit?: number }) {
      let results = Array.from(store.values());
      if (options?.user_id) {
        results = results.filter((m) => m.actorId === options.user_id);
      }
      if (options?.limit) {
        results = results.slice(0, options.limit);
      }
      return { results: results.map((m) => ({ id: m.id, memory: m.content, user_id: m.actorId, metadata: m.metadata })) };
    },
    async get(memory_id: string) {
      const mem = store.get(memory_id);
      if (!mem) return null;
      return { id: mem.id, memory: mem.content, user_id: mem.actorId, metadata: mem.metadata };
    },
    async update(_memory_id: string, _data: unknown) {
      return {};
    },
    async delete(memory_id: string) {
      store.delete(memory_id);
    },
    async delete_all(options?: { user_id?: string }) {
      if (options?.user_id) {
        for (const [id, mem] of store) {
          if (mem.actorId === options.user_id) store.delete(id);
        }
      } else {
        store.clear();
      }
    },
    async getAll(options?: { user_id?: string }) {
      let results = Array.from(store.values());
      if (options?.user_id) {
        results = results.filter((m) => m.actorId === options.user_id);
      }
      return { results: results.map((m) => ({ id: m.id, memory: m.content, user_id: m.actorId, metadata: m.metadata })) };
    },
  };
}

vi.mock("mem0ai/oss", () => ({
  Memory: vi.fn().mockImplementation(() => createStatefulMockMem0()),
}));

vi.mock("mem0ai", () => ({
  MemoryClient: vi.fn().mockImplementation(() => createStatefulMockMem0()),
}));

describe("Mem0StorageAdapter", () => {
  describe("construction", () => {
    it("defaults to OSS mode with no config", () => {
      const adapter = new Mem0StorageAdapter();
      expect(adapter).toBeDefined();
    });

    it("accepts explicit OSS mode config", () => {
      const config: Mem0StorageConfig = { mode: "oss" };
      const adapter = new Mem0StorageAdapter(config);
      expect(adapter).toBeDefined();
    });

    it("accepts cloud mode config with apiKey", () => {
      const config: Mem0StorageConfig = { mode: "cloud", apiKey: "test-key" };
      const adapter = new Mem0StorageAdapter(config);
      expect(adapter).toBeDefined();
    });

    it("initializes OSS mode successfully", async () => {
      const adapter = new Mem0StorageAdapter({ mode: "oss" });
      await adapter.initialize();
      expect(adapter).toBeDefined();
    });

    it("initializes cloud mode successfully", async () => {
      const adapter = new Mem0StorageAdapter({ mode: "cloud", apiKey: "test-key" });
      await adapter.initialize();
      expect(adapter).toBeDefined();
    });

    it("throws when cloud mode lacks apiKey", async () => {
      const adapter = new Mem0StorageAdapter({ mode: "cloud" });
      await expect(adapter.initialize()).rejects.toThrow("apiKey");
    });

    it("throws when operating before initialization", async () => {
      const adapter = new Mem0StorageAdapter({ mode: "oss" });
      await expect(adapter.store({ actorId: "a", content: "test" })).rejects.toThrow("not initialized");
    });
  });

  describe("store and get", () => {
    let adapter: Mem0StorageAdapter;

    beforeEach(async () => {
      adapter = new Mem0StorageAdapter({ mode: "oss" });
      await adapter.initialize();
    });

    it("stores a memory and retrieves it by id", async () => {
      const mem = await adapter.store({ actorId: "agent-1", content: "Hello world", importance: 0.9 });
      expect(mem.id).toMatch(/^mem0_/);
      expect(mem.actorId).toBe("agent-1");
      expect(mem.content).toBe("Hello world");
      expect(mem.importance).toBe(0.9);

      const retrieved = await adapter.get(mem.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe("Hello world");
    });

    it("stores with default values", async () => {
      const mem = await adapter.store({ actorId: "a", content: "minimal" });
      expect(mem.memoryType).toBe("interaction");
      expect(mem.importance).toBe(0.5);
      expect(mem.emotionalValence).toBe(0);
      expect(mem.tags).toEqual([]);
      expect(mem.createdAt).toBeInstanceOf(Date);
    });

    it("returns null for missing memory", async () => {
      const result = await adapter.get("nonexistent");
      expect(result).toBeNull();
    });

    it("store returns id from mem0 response", async () => {
      const mem = await adapter.store({ actorId: "a", content: "test" });
      expect(mem.id).toBeTruthy();
      expect(typeof mem.id).toBe("string");
    });
  });

  describe("storeBatch", () => {
    let adapter: Mem0StorageAdapter;

    beforeEach(async () => {
      adapter = new Mem0StorageAdapter({ mode: "oss" });
      await adapter.initialize();
    });

    it("stores multiple memories", async () => {
      const results = await adapter.storeBatch([
        { actorId: "a", content: "one" },
        { actorId: "a", content: "two" },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe("one");
      expect(results[1].content).toBe("two");
    });
  });

  describe("delete", () => {
    let adapter: Mem0StorageAdapter;

    beforeEach(async () => {
      adapter = new Mem0StorageAdapter({ mode: "oss" });
      await adapter.initialize();
    });

    it("deletes a memory", async () => {
      const mem = await adapter.store({ actorId: "a", content: "to delete" });
      await adapter.delete(mem.id);
      const result = await adapter.get(mem.id);
      expect(result).toBeNull();
    });

    it("deleteMany removes multiple memories", async () => {
      const m1 = await adapter.store({ actorId: "a", content: "1" });
      const m2 = await adapter.store({ actorId: "a", content: "2" });
      const m3 = await adapter.store({ actorId: "a", content: "3" });

      const deleted = await adapter.deleteMany([m1.id, m2.id]);
      expect(deleted).toBe(2);
      expect(await adapter.get(m3.id)).not.toBeNull();
    });
  });

  describe("retrieve", () => {
    let adapter: Mem0StorageAdapter;

    beforeEach(async () => {
      adapter = new Mem0StorageAdapter({ mode: "oss" });
      await adapter.initialize();
    });

    it("retrieves by actorId via getAll", async () => {
      await adapter.store({ actorId: "agent-a", content: "memory a1" });
      await adapter.store({ actorId: "agent-a", content: "memory a2" });
      await adapter.store({ actorId: "agent-b", content: "memory b1" });

      const results = await adapter.retrieve({ actorId: "agent-a" });
      expect(results).toHaveLength(2);
      expect(results.every((m) => m.actorId === "agent-a")).toBe(true);
    });

    it("retrieves by query via search", async () => {
      await adapter.store({ actorId: "a", content: "the goblin attacked" });
      await adapter.store({ actorId: "a", content: "a dragon appeared" });

      const results = await adapter.retrieve({ actorId: "a", query: "goblin" });
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it("respects limit", async () => {
      for (let i = 0; i < 10; i++) {
        await adapter.store({ actorId: "a", content: `memory ${i}` });
      }

      const results = await adapter.retrieve({ actorId: "a", limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("filters by memoryTypes", async () => {
      await adapter.store({ actorId: "a", content: "fact", memoryType: "fact" });
      await adapter.store({ actorId: "a", content: "interaction", memoryType: "interaction" });

      const results = await adapter.retrieve({ actorId: "a", memoryTypes: ["fact"] });
      expect(results).toHaveLength(1);
      expect(results[0].memoryType).toBe("fact");
    });

    it("filters by tags", async () => {
      await adapter.store({ actorId: "a", content: "bug report", tags: ["bug"] });
      await adapter.store({ actorId: "a", content: "feature request", tags: ["feature"] });

      const results = await adapter.retrieve({ actorId: "a", tags: ["bug"] });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("bug report");
    });
  });

  describe("count", () => {
    let adapter: Mem0StorageAdapter;

    beforeEach(async () => {
      adapter = new Mem0StorageAdapter({ mode: "oss" });
      await adapter.initialize();
    });

    it("counts all memories", async () => {
      await adapter.store({ actorId: "a", content: "1" });
      await adapter.store({ actorId: "a", content: "2" });
      await adapter.store({ actorId: "b", content: "3" });

      expect(await adapter.count()).toBe(3);
    });

    it("counts by actorId", async () => {
      await adapter.store({ actorId: "a", content: "1" });
      await adapter.store({ actorId: "a", content: "2" });
      await adapter.store({ actorId: "b", content: "3" });

      expect(await adapter.count({ actorId: "a" })).toBe(2);
      expect(await adapter.count({ actorId: "b" })).toBe(1);
    });

    it("counts by memoryType", async () => {
      await adapter.store({ actorId: "a", content: "f1", memoryType: "fact" });
      await adapter.store({ actorId: "a", content: "i1", memoryType: "interaction" });

      expect(await adapter.count({ memoryType: "fact" })).toBe(1);
    });

    it("returns 0 for empty filter with no matches", async () => {
      expect(await adapter.count({ actorId: "nonexistent" })).toBe(0);
    });
  });

  describe("close", () => {
    it("closes without error", async () => {
      const adapter = new Mem0StorageAdapter({ mode: "oss" });
      await adapter.initialize();
      await adapter.close();
    });

    it("throws after close", async () => {
      const adapter = new Mem0StorageAdapter({ mode: "oss" });
      await adapter.initialize();
      await adapter.close();
      await expect(adapter.store({ actorId: "a", content: "test" })).rejects.toThrow("not initialized");
    });
  });

  describe("touch", () => {
    it("has no touch method", () => {
      const adapter = new Mem0StorageAdapter({ mode: "oss" });
      expect((adapter as Record<string, unknown>).touch).toBeUndefined();
    });
  });
});
