import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DiskStorageAdapter } from "../src/adapters/storage/disk.js";

const TEST_DIR = join(import.meta.dirname ?? process.cwd(), ".memstack-test");

describe("DiskStorageAdapter", () => {
  let storage: DiskStorageAdapter;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    storage = new DiskStorageAdapter({ storageDir: TEST_DIR });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("stores and retrieves a memory", async () => {
    const mem = await storage.store({ actorId: "npc_1", content: "Hello world" });

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

  it("deletes a memory", async () => {
    const mem = await storage.store({ actorId: "a", content: "test" });

    await storage.delete(mem.id);
    const result = await storage.get(mem.id);
    expect(result).toBeNull();
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

    const results = await storage.retrieve({ actorId: "a", strategy: "important", limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("important");
  });

  it("retrieves by query text", async () => {
    await storage.store({ actorId: "a", content: "The goblin attacked" });
    await storage.store({ actorId: "a", content: "A dragon appeared" });

    const results = await storage.retrieve({ actorId: "a", query: "goblin" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("The goblin attacked");
  });

  it("stores batch", async () => {
    const results = await storage.storeBatch([
      { actorId: "a", content: "one" },
      { actorId: "a", content: "two" },
    ]);

    expect(results).toHaveLength(2);
    expect(await storage.count()).toBe(2);
  });

  it("persists across storage instances", async () => {
    await storage.store({ actorId: "npc_1", content: "persisted" });
    await storage.close();

    const storage2 = new DiskStorageAdapter({ storageDir: TEST_DIR });
    await storage2.initialize();
    const count = await storage2.count({ actorId: "npc_1" });
    expect(count).toBe(1);

    const results = await storage2.retrieve({ actorId: "npc_1" });
    expect(results[0].content).toBe("persisted");
    await storage2.close();
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

  it("deleteMany removes multiple memories", async () => {
    const m1 = await storage.store({ actorId: "a", content: "1" });
    const m2 = await storage.store({ actorId: "a", content: "2" });
    const m3 = await storage.store({ actorId: "a", content: "3" });

    const deleted = await storage.deleteMany([m1.id, m3.id]);
    expect(deleted).toBe(2);
    expect(await storage.count({ actorId: "a" })).toBe(1);
  });
});
