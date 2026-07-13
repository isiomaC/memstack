import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MarkdownStorageAdapter } from "../src/adapters/storage/markdown.js";

const TEST_DIR = join(import.meta.dirname ?? process.cwd(), ".memstack-markdown-test");

describe("MarkdownStorageAdapter", () => {
  let storage: MarkdownStorageAdapter;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    storage = new MarkdownStorageAdapter({ dir: TEST_DIR });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("stores and retrieves a memory", async () => {
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
    const result = await storage.get("nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a memory with tombstone", async () => {
    const mem = await storage.store({ actorId: "a", content: "test" });

    await storage.delete(mem.id);
    const result = await storage.get(mem.id);
    expect(result).toBeNull();
  });

  it("throws notFound when deleting missing memory", async () => {
    await expect(storage.delete("nonexistent")).rejects.toThrow("not found");
  });

  it("counts by actorId", async () => {
    await storage.store({ actorId: "a", content: "1" });
    await storage.store({ actorId: "a", content: "2" });
    await storage.store({ actorId: "b", content: "3" });

    expect(await storage.count({ actorId: "a" })).toBe(2);
    expect(await storage.count({ actorId: "b" })).toBe(1);
    expect(await storage.count()).toBe(3);
  });

  it("retrieves by strategy", async () => {
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
    await storage.store({ actorId: "a", content: "The goblin attacked" });
    await storage.store({ actorId: "a", content: "A dragon appeared" });

    const results = await storage.retrieve({
      actorId: "a",
      query: "goblin",
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("The goblin attacked");
  });

  it("retrieves by multi-word query text (OR over terms, not exact phrase)", async () => {
    await storage.store({ actorId: "a", content: "The goblin attacked the village" });
    await storage.store({ actorId: "a", content: "A dragon appeared in the sky" });
    await storage.store({ actorId: "a", content: "Nothing relevant here" });

    const results = await storage.retrieve({ actorId: "a", query: "goblin dragon" });
    const contents = results.map((m) => m.content).sort();
    expect(contents).toEqual(["A dragon appeared in the sky", "The goblin attacked the village"]);
  });

  it("stores batch", async () => {
    const results = await storage.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await storage.count()).toBe(2);
  });

  it("deleteMany removes multiple memories", async () => {
    const m1 = await storage.store({ actorId: "a", content: "1" });
    const m2 = await storage.store({ actorId: "a", content: "2" });
    const m3 = await storage.store({ actorId: "a", content: "3" });

    const deleted = await storage.deleteMany([m1.id, m3.id]);
    expect(deleted).toBe(2);
    expect(await storage.count({ actorId: "a" })).toBe(1);

    const remaining = await storage.get(m2.id);
    expect(remaining).not.toBeNull();
  });

  it("filters expired memories", async () => {
    const past = new Date(Date.now() - 10_000);
    await storage.store({ actorId: "a", content: "expired", expiresAt: past });
    await storage.store({ actorId: "a", content: "valid" });

    const count = await storage.count({ actorId: "a" });
    expect(count).toBe(1);

    const results = await storage.retrieve({ actorId: "a" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("valid");
  });

  it("persists across storage instances", async () => {
    await storage.store({ actorId: "npc_1", content: "persisted" });
    await storage.close();

    const storage2 = new MarkdownStorageAdapter({ dir: TEST_DIR });
    await storage2.initialize();
    const count = await storage2.count({ actorId: "npc_1" });
    expect(count).toBe(1);

    const results = await storage2.retrieve({ actorId: "npc_1" });
    expect(results[0].content).toBe("persisted");
    await storage2.close();
  });

  it("vacuum removes tombstones", async () => {
    const m1 = await storage.store({ actorId: "a", content: "keep me" });
    const m2 = await storage.store({ actorId: "a", content: "delete me" });
    const m3 = await storage.store({ actorId: "a", content: "keep me too" });

    await storage.delete(m2.id);

    await storage.vacuum();

    const filePath = join(TEST_DIR, "a.md");
    const raw = await readFile(filePath, "utf-8");
    expect(raw).not.toContain("deleted:");
    expect(raw).toContain("keep me");
    expect(raw).toContain("keep me too");
    expect(raw).not.toContain("delete me");

    expect(await storage.get(m2.id)).toBeNull();
    expect(await storage.get(m1.id)).not.toBeNull();
    expect(await storage.get(m3.id)).not.toBeNull();
  });

  it("vacuum preserves non-tombstoned blocks", async () => {
    const m1 = await storage.store({ actorId: "a", content: "alpha" });
    const m2 = await storage.store({ actorId: "a", content: "beta" });
    await storage.delete(m1.id);

    await storage.vacuum();

    const results = await storage.retrieve({ actorId: "a" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("beta");
  });

  it("supports oneFilePerActor: false mode", async () => {
    await storage.close();

    const shared = new MarkdownStorageAdapter({ dir: TEST_DIR, oneFilePerActor: false });
    await shared.initialize();

    const m1 = await shared.store({ actorId: "actor_a", content: "hello a" });
    const m2 = await shared.store({ actorId: "actor_b", content: "hello b" });

    expect(await shared.count()).toBe(2);
    expect(await shared.count({ actorId: "actor_a" })).toBe(1);

    const resultsA = await shared.retrieve({ actorId: "actor_a" });
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].content).toBe("hello a");

    const resultsB = await shared.retrieve({ actorId: "actor_b" });
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].content).toBe("hello b");

    const filePath = join(TEST_DIR, "memories.md");
    const raw = await readFile(filePath, "utf-8");
    expect(raw).toContain("actor_a");
    expect(raw).toContain("actor_b");

    await shared.delete(m1.id);
    expect(await shared.get(m1.id)).toBeNull();

    await shared.close();
  });

  it("returns null for tombstoned memory after vacuum", async () => {
    const mem = await storage.store({ actorId: "a", content: "doomed" });
    await storage.delete(mem.id);
    await storage.vacuum();

    const result = await storage.get(mem.id);
    expect(result).toBeNull();
  });

  it("retrieve excludes deleted memories", async () => {
    const m1 = await storage.store({ actorId: "a", content: "alive" });
    const m2 = await storage.store({ actorId: "a", content: "dead" });
    await storage.delete(m2.id);

    const results = await storage.retrieve({ actorId: "a" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(m1.id);
  });

  it("handles multiple actors with oneFilePerActor: true", async () => {
    const m1 = await storage.store({ actorId: "hero", content: "sword" });
    const m2 = await storage.store({ actorId: "villain", content: "lair" });

    expect(await storage.count({ actorId: "hero" })).toBe(1);
    expect(await storage.count({ actorId: "villain" })).toBe(1);
    expect(await storage.count()).toBe(2);

    await storage.delete(m1.id);
    expect(await storage.count({ actorId: "hero" })).toBe(0);
    expect(await storage.count({ actorId: "villain" })).toBe(1);
  });

  it("retrieve respects limit", async () => {
    await storage.store({ actorId: "a", content: "first" });
    await storage.store({ actorId: "a", content: "second" });
    await storage.store({ actorId: "a", content: "third" });

    const results = await storage.retrieve({ actorId: "a", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("stores with custom id", async () => {
    const mem = await storage.store({
      actorId: "a",
      content: "custom id",
      id: "my-custom-id",
    });

    expect(mem.id).toBe("my-custom-id");
    const retrieved = await storage.get("my-custom-id");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("custom id");
  });
});
