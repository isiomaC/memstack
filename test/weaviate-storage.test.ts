import { describe, it, expect, beforeEach } from "vitest";
import { WeaviateStorageAdapter } from "../src/adapters/storage/weaviate.js";

type StoredEntry = {
  properties: Record<string, unknown>;
  vectors: number[];
};

type FilterNode =
  | { operator: "Equal"; target: { property: string }; value: unknown }
  | { operator: "GreaterThanEqual"; target: { property: string }; value: number }
  | { operator: "ContainsAny"; target: { property: string }; values: unknown[] }
  | { operator: "Like"; target: { property: string }; value: string }
  | { operator: "And"; operands?: FilterNode[]; filters?: FilterNode[] }
  | { operator: "Or"; operands?: FilterNode[]; filters?: FilterNode[] };

function evaluateFilter(filter: FilterNode, props: Record<string, unknown>): boolean {
  const children = (filter as { filters?: FilterNode[] }).filters ?? (filter as { operands?: FilterNode[] }).operands ?? [];
  switch (filter.operator) {
    case "Equal": {
      const pv = props[filter.target.property];
      return pv === filter.value;
    }
    case "GreaterThanEqual": {
      const pv = props[filter.target.property] as number;
      return pv >= filter.value;
    }
    case "ContainsAny": {
      const arr = Array.isArray(props[filter.target.property])
        ? (props[filter.target.property] as string[])
        : [];
      return (filter.values as string[]).some((v) => arr.includes(v));
    }
    case "Like": {
      const val = String(props[filter.target.property] ?? "");
      const pattern = String(filter.value).replace(/\*/g, ".*");
      return new RegExp(pattern, "i").test(val);
    }
    case "And":
      return children.every((op) => evaluateFilter(op as FilterNode, props));
    case "Or":
      return children.some((op) => evaluateFilter(op as FilterNode, props));
    default:
      return true;
  }
}

function createMockWeaviate() {
  const data = new Map<string, StoredEntry>();

  return {
    collections: {
      async exists(_name: string) {
        return true;
      },
      get(_name: string) {
        return {
          data: {
            async insert(opts: { properties: Record<string, unknown>; vectors: number[]; id?: string }) {
              const id = opts.id ?? crypto.randomUUID();
              data.set(id, { properties: opts.properties, vectors: opts.vectors });
              return id;
            },
            async deleteById(id: string) {
              data.delete(id);
            },
          },
          query: {
            async fetchObjectById(id: string, _opts?: { includeVector?: boolean }) {
              const entry = data.get(id);
              if (!entry) return null;
              return { properties: entry.properties, vectors: { default: entry.vectors } };
            },
            async fetchObjects(opts: { limit: number; filters?: FilterNode }) {
              let results = Array.from(data.entries()).map(([uuid, entry]) => ({
                uuid,
                properties: entry.properties,
                vectors: { default: entry.vectors },
              }));

              if (opts.filters) {
                results = results.filter((r) => evaluateFilter(opts.filters as FilterNode, r.properties));
              }

              if (opts.limit && opts.limit > 0) {
                results = results.slice(0, opts.limit);
              }

              return { objects: results };
            },
            async nearVector(
              _vector: number[],
              opts: { limit: number; filters?: FilterNode; includeVector?: boolean },
            ) {
              let results = Array.from(data.entries()).map(([uuid, entry]) => ({
                uuid,
                properties: entry.properties,
                vectors: { default: entry.vectors },
              }));

              if (opts.filters) {
                results = results.filter((r) => evaluateFilter(opts.filters as FilterNode, r.properties));
              }

              if (opts.limit && opts.limit > 0) {
                results = results.slice(0, opts.limit);
              }

              return { objects: results };
            },
          },
          config: {
            async get() {
              return { name: "MemstackMemory" };
            },
            async update() {},
          },
        };
      },
      async create() {},
      async delete() {},
      async listAll() {
        return [];
      },
    },
  };
}

describe("WeaviateStorageAdapter", () => {
  let mock: ReturnType<typeof createMockWeaviate>;
  let adapter: WeaviateStorageAdapter;

  beforeEach(() => {
    mock = createMockWeaviate();
    adapter = new WeaviateStorageAdapter({ client: mock });
  });

  it("constructs with default className", () => {
    expect(adapter).toBeDefined();
  });

  it("constructs with custom className", () => {
    const custom = new WeaviateStorageAdapter({
      client: mock,
      className: "CustomMemory",
    });
    expect(custom).toBeDefined();
  });

  it("initializes without error", async () => {
    await expect(adapter.initialize()).resolves.toBeUndefined();
  });

  it("stores and retrieves a memory", async () => {
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
    expect(retrieved!.id).toBe(mem.id);
  });

  it("returns null for missing memory", async () => {
    const result = await adapter.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const mem = await adapter.store({ actorId: "a", content: "test" });

    await adapter.delete(mem.id);
    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("throws notFound when deleting non-existent memory", async () => {
    await expect(adapter.delete("nonexistent")).rejects.toThrow("Memory not found");
  });

  it("stores batch", async () => {
    const results = await adapter.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].id).toMatch(/^mem_/);
    expect(results[1].id).toMatch(/^mem_/);

    const m1 = await adapter.get(results[0].id);
    const m2 = await adapter.get(results[1].id);
    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();
  });

  it("counts memories", async () => {
    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "b", content: "3" });

    expect(await adapter.count()).toBe(3);
    expect(await adapter.count({ actorId: "a" })).toBe(2);
    expect(await adapter.count({ actorId: "b" })).toBe(1);
  });

  it("retrieves by recent strategy", async () => {
    await adapter.store({ actorId: "a", content: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await adapter.store({ actorId: "a", content: "second" });

    const results = await adapter.retrieve({ actorId: "a", strategy: "recent", limit: 2 });
    expect(results).toHaveLength(2);
    const contents = results.map((r) => r.content);
    expect(contents).toContain("first");
    expect(contents).toContain("second");
  });

  it("retrieves by important strategy", async () => {
    await adapter.store({ actorId: "a", content: "low", importance: 0.1 });
    await adapter.store({ actorId: "a", content: "high", importance: 0.9 });

    const results = await adapter.retrieve({ actorId: "a", strategy: "important", limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("high");
  });

  it("retrieves by semantic strategy with near vector", async () => {
    const m1 = await adapter.store({ actorId: "a", content: "goblin", embedding: [0.1, 0.2] });
    const m2 = await adapter.store({ actorId: "a", content: "dragon", embedding: [0.9, 0.8] });

    const results = await adapter.retrieve(
      { actorId: "a", strategy: "semantic", limit: 2 },
      [0.1, 0.2],
    );

    expect(results).toHaveLength(2);
  });

  it("retrieves by hybrid strategy with near vector", async () => {
    await adapter.store({ actorId: "a", content: "test", embedding: [0.5, 0.5] });

    const results = await adapter.retrieve(
      { actorId: "a", strategy: "hybrid", limit: 1 },
      [0.5, 0.5],
    );

    expect(results).toHaveLength(1);
  });

  it("retrieves by query text", async () => {
    await adapter.store({ actorId: "a", content: "The goblin attacked" });
    await adapter.store({ actorId: "a", content: "A dragon appeared" });

    const results = await adapter.retrieve({ actorId: "a", query: "goblin" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("The goblin attacked");
  });

  it("filters expired memories on get", async () => {
    const past = new Date(Date.now() - 10_000);
    const mem = await adapter.store({ actorId: "a", content: "expired", expiresAt: past });

    const result = await adapter.get(mem.id);
    expect(result).toBeNull();
  });

  it("filters expired memories on retrieve", async () => {
    const past = new Date(Date.now() - 10_000);
    await adapter.store({ actorId: "a", content: "expired", expiresAt: past });
    await adapter.store({ actorId: "a", content: "valid" });

    const results = await adapter.retrieve({ actorId: "a" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("valid");
  });

  it("filters by memoryTypes on retrieve", async () => {
    await adapter.store({ actorId: "a", content: "inter", memoryType: "interaction" });
    await adapter.store({ actorId: "a", content: "obs", memoryType: "observation" });

    const results = await adapter.retrieve({
      actorId: "a",
      memoryTypes: ["observation"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("obs");
  });

  it("filters by tags on retrieve", async () => {
    await adapter.store({ actorId: "a", content: "tagged", tags: ["combat"] });
    await adapter.store({ actorId: "a", content: "untagged", tags: [] });

    const results = await adapter.retrieve({ actorId: "a", tags: ["combat"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("tagged");
  });

  it("respects limit on retrieve", async () => {
    await adapter.store({ actorId: "a", content: "1" });
    await adapter.store({ actorId: "a", content: "2" });
    await adapter.store({ actorId: "a", content: "3" });

    const results = await adapter.retrieve({ actorId: "a", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("deleteMany removes multiple memories", async () => {
    const m1 = await adapter.store({ actorId: "a", content: "1" });
    const m2 = await adapter.store({ actorId: "a", content: "2" });
    const m3 = await adapter.store({ actorId: "a", content: "3" });

    const deleted = await adapter.deleteMany([m1.id, m3.id]);
    expect(deleted).toBe(2);
    expect(await adapter.get(m1.id)).toBeNull();
    expect(await adapter.get(m2.id)).not.toBeNull();
    expect(await adapter.get(m3.id)).toBeNull();
  });

  it("counts with filter", async () => {
    await adapter.store({ actorId: "a", content: "low", importance: 0.1 });
    await adapter.store({ actorId: "a", content: "high", importance: 0.9 });
    await adapter.store({ actorId: "a", content: "mid", importance: 0.5, memoryType: "fact" });

    expect(await adapter.count({ actorId: "a", minImportance: 0.5 })).toBe(2);
    expect(await adapter.count({ actorId: "a", memoryType: "fact" })).toBe(1);
    expect(await adapter.count({ actorId: "a", minImportance: 0.9, memoryType: "interaction" })).toBe(1);
  });

  it("handles close as no-op", async () => {
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("preserves metadata and tags through round-trip", async () => {
    const mem = await adapter.store({
      actorId: "a",
      content: "test",
      metadata: { key: "value", nested: { a: 1 } },
      tags: ["important", "pinned"],
      sourceId: "src_123",
    });

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.metadata).toEqual({ key: "value", nested: { a: 1 } });
    expect(retrieved!.tags).toEqual(["important", "pinned"]);
    expect(retrieved!.sourceId).toBe("src_123");
  });

  it("generates unique IDs", async () => {
    const m1 = await adapter.store({ actorId: "a", content: "1" });
    const m2 = await adapter.store({ actorId: "a", content: "2" });

    expect(m1.id).not.toBe(m2.id);
  });
});
