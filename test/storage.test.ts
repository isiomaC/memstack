import { describe, it, expect } from "vitest";
import { InMemoryStorage } from "../src/adapters/storage/memory.js";

describe("InMemoryStorage", () => {
  it("stores and retrieves a memory", async () => {
    const storage = new InMemoryStorage();
    const mem = await storage.store({
      actorId: "npc_1",
      content: "Hello world",
    });

    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("npc_1");
    expect(mem.content).toBe("Hello world");
    expect(mem.memoryType).toBe("interaction");
    expect(mem.createdAt).toBeInstanceOf(Date);

    const retrieved = await storage.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Hello world");
  });

  it("returns null for missing memory", async () => {
    const storage = new InMemoryStorage();
    const result = await storage.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory", async () => {
    const storage = new InMemoryStorage();
    const mem = await storage.store({ actorId: "a", content: "test" });

    await storage.delete(mem.id);
    const result = await storage.get(mem.id);
    expect(result).toBeNull();
  });

  it("counts by actorId", async () => {
    const storage = new InMemoryStorage();
    await storage.store({ actorId: "a", content: "1" });
    await storage.store({ actorId: "a", content: "2" });
    await storage.store({ actorId: "b", content: "3" });

    expect(await storage.count({ actorId: "a" })).toBe(2);
    expect(await storage.count({ actorId: "b" })).toBe(1);
    expect(await storage.count()).toBe(3);
  });

  it("retrieves by strategy", async () => {
    const storage = new InMemoryStorage();
    await storage.store({ actorId: "a", content: "old", importance: 0.1 });
    await storage.store({ actorId: "a", content: "important", importance: 0.9 });

    const results = await storage.retrieve({
      actorId: "a",
      strategy: "important",
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("important");
  });

  it("retrieves by query text", async () => {
    const storage = new InMemoryStorage();
    await storage.store({ actorId: "a", content: "The goblin attacked" });
    await storage.store({ actorId: "a", content: "A dragon appeared" });

    const results = await storage.retrieve({
      actorId: "a",
      query: "goblin",
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("The goblin attacked");
  });

  it("stores batch", async () => {
    const storage = new InMemoryStorage();
    const results = await storage.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await storage.count()).toBe(2);
  });
});
