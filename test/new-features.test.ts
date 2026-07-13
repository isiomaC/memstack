import { describe, it, expect } from "vitest";
import { MemStack } from "../src/client.js";
import { MemoryStore } from "../src/memory/MemoryStore.js";
import { InMemoryStorageAdapter } from "../src/adapters/storage/memory.js";
import { ContextCompiler } from "../src/memory/ContextCompiler.js";

// ── Helpers ──

const mockLLM = {
  async complete(request: { system: string; user: string }) {
    return {
      text: request.user.substring(0, 50),
      tokens: { prompt: 10, completion: 5, total: 15 },
    };
  },
};

function enrichedMockLLM(tagsResponse: string, importanceResponse?: string) {
  return {
    async complete(request: { system: string }) {
      if (request.system.includes("importance") && !request.system.includes("tags")) {
        return { text: importanceResponse ?? "0.77", tokens: { prompt: 5, completion: 1, total: 6 } };
      }
      if (request.system.includes("tags") && !request.system.includes("importance")) {
        return { text: tagsResponse, tokens: { prompt: 5, completion: 1, total: 6 } };
      }
      // Combined enrichment
      return { text: tagsResponse, tokens: { prompt: 5, completion: 1, total: 6 } };
    },
  };
}

// ── Auto-enrichment ──

describe("auto-enrichment", () => {
  it("scores importance via LLM when autoImportance enabled and importance missing", async () => {
    const llm = enrichedMockLLM("", "0.42");
    const ms = new MemStack({ llm: llm as never, defaults: { autoImportance: true } });
    const result = await ms.process({ actorId: "a", content: "trivial note" });
    expect(result.memory.importance).toBe(0.42);
  });

  it("respects explicit importance even when autoImportance enabled", async () => {
    const llm = enrichedMockLLM("", "0.42");
    const ms = new MemStack({ llm: llm as never, defaults: { autoImportance: true } });
    const result = await ms.process({ actorId: "a", content: "trivial note", importance: 0.99 });
    expect(result.memory.importance).toBe(0.99);
  });

  it("defaults to 0.5 when autoImportance LLM returns garbage", async () => {
    const llm = {
      async complete() {
        return { text: "not a number", tokens: { prompt: 1, completion: 1, total: 2 } };
      },
    };
    const ms = new MemStack({ llm: llm as never, defaults: { autoImportance: true } });
    const result = await ms.process({ actorId: "a", content: "test" });
    expect(result.memory.importance).toBe(0.5);
  });

  it("extracts tags via LLM when autoTags enabled and tags missing", async () => {
    const llm = enrichedMockLLM('["combat","goblin"]');
    const ms = new MemStack({ llm: llm as never, defaults: { autoTags: true } });
    const result = await ms.process({ actorId: "a", content: "A goblin attacked the village" });
    expect(result.memory.tags).toEqual(["combat", "goblin"]);
  });

  it("preserves explicit tags even when autoTags enabled", async () => {
    const llm = enrichedMockLLM('["ignored"]');
    const ms = new MemStack({ llm: llm as never, defaults: { autoTags: true } });
    const result = await ms.process({ actorId: "a", content: "test", tags: ["manual"] });
    expect(result.memory.tags).toEqual(["manual"]);
  });

  it("handles markdown-wrapped JSON from LLM", async () => {
    const llm = enrichedMockLLM('```json\n{"importance": 0.91, "tags": ["exploration"]}\n```');
    const ms = new MemStack({ llm: llm as never, defaults: { autoImportance: true, autoTags: true } });
    const result = await ms.process({ actorId: "a", content: "Discovered a hidden cave" });
    expect(result.memory.importance).toBe(0.91);
    expect(result.memory.tags).toEqual(["exploration"]);
  });

  it("batches importance+tags into single LLM call", async () => {
    let callCount = 0;
    const llm = {
      async complete() {
        callCount++;
        return { text: '{"importance": 0.6, "tags": ["diplomacy"]}', tokens: { prompt: 1, completion: 1, total: 2 } };
      },
    };
    const ms = new MemStack({ llm: llm as never, defaults: { autoImportance: true, autoTags: true } });
    await ms.process({ actorId: "a", content: "Negotiated peace treaty" });
    expect(callCount).toBe(1);
    // Confidence check: neither enabled → batching shouldn't apply
    const ms2 = new MemStack({ llm: llm as never, defaults: {} });
    await ms2.process({ actorId: "a", content: "test" });
    expect(callCount).toBe(1);
  });

  it("reports enrichment errors to hooks.onError", async () => {
    const errors: Error[] = [];
    const llm = {
      async complete() {
        throw new Error("enrichment failed");
      },
    };
    const ms = new MemStack({
      llm: llm as never,
      defaults: { autoImportance: true },
      hooks: { onError: (err) => errors.push(err) },
    });
    const result = await ms.process({ actorId: "a", content: "test" });
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe("enrichment failed");
    expect(result.memory.importance).toBe(0.5);
  });
});

// ── onConflict: append ──

describe("onConflict append", () => {
  it("deduplicates by content hash — returns existing instead of creating duplicate", async () => {
    const store = new MemoryStore({ storage: new InMemoryStorageAdapter() });
    const first = await store.store({ actorId: "a", content: "unique observation", importance: 0.3, tags: ["science"] });
    const second = await store.store({ actorId: "a", content: "unique observation", importance: 0.8, tags: ["repeat"], onConflict: "append" });

    // Should return existing memory (via upsert), same ID
    expect(second.id).toBe(first.id);
    // Importance updated to new value
    expect(second.importance).toBe(0.8);
    // Tags merged
    expect(second.tags.sort()).toEqual(["repeat", "science"]);
    // Only one memory stored
    expect(await store.count({ actorId: "a" })).toBe(1);
  });

  it("stores normally when onConflict not set", async () => {
    const store = new MemoryStore({ storage: new InMemoryStorageAdapter() });
    const first = await store.store({ actorId: "a", content: "duplicate" });
    const second = await store.store({ actorId: "a", content: "duplicate" });
    expect(second.id).not.toBe(first.id);
    expect(await store.count({ actorId: "a" })).toBe(2);
  });

  it("storeBatch routes append inputs through dedup", async () => {
    const store = new MemoryStore({ storage: new InMemoryStorageAdapter() });
    const first = await store.store({ actorId: "a", content: "batch dedup" });
    const results = await store.storeBatch([
      { actorId: "a", content: "batch dedup", onConflict: "append" },
      { actorId: "b", content: "normal", onConflict: "append" },
    ]);
    // First input matched existing → returned existing ID
    expect(results[0].id).toBe(first.id);
    // Second input no match → new ID
    expect(results[1].id).not.toBe(first.id);
    expect(await store.count()).toBe(2);
  });

  it("upserts in DiskStorageAdapter without duplicate records", async () => {
    const { DiskStorageAdapter } = await import("../src/adapters/storage/disk.js");
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const dir = join(import.meta.dirname ?? process.cwd(), ".memstack-append-disk-test");
    await rm(dir, { recursive: true, force: true });

    const storage = new DiskStorageAdapter({ storageDir: dir });
    await storage.initialize();
    const store = new MemoryStore({ storage });

    const first = await store.store({ actorId: "a", content: "disk dedup", importance: 0.3, tags: ["v1"] });
    const second = await store.store({ actorId: "a", content: "disk dedup", importance: 0.8, tags: ["v2"], onConflict: "append" });

    expect(second.id).toBe(first.id);
    expect(second.importance).toBe(0.8);
    expect(second.tags.sort()).toEqual(["v1", "v2"]);
    expect(await store.count({ actorId: "a" })).toBe(1);

    // Verify on-disk file has exactly one record
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(join(dir, "a.json"), "utf-8"));
    expect(raw.length).toBe(1);

    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── Token-aware compileContext ──

describe("ContextCompiler truncation", () => {
  function makeMemories(content: string): import("../src/types.js").Memory[] {
    return [...Array(10)].map((_, i) => ({
      id: `m${i}`,
      actorId: "a",
      memoryType: "interaction" as const,
      content: `${content} #${i}`,
      importance: i < 3 ? 0.9 : 0.3,
      emotionalValence: 0,
      tags: [],
      createdAt: new Date(Date.now() - (10 - i) * 60000),
    }));
  }

  it("truncates content to fit tight token budget instead of dropping", () => {
    const compiler = new ContextCompiler();
    const memories = makeMemories("The quick brown fox jumps over the lazy dog");
    const result = compiler.compile(memories, { actorId: "a", maxTokens: 20 });
    // With a 20-token budget, content must be truncated, not empty
    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.tokenEstimate).toBeLessThanOrEqual(30); // some overhead from headers
  });

  it("fills budget without truncation when content fits", () => {
    const compiler = new ContextCompiler();
    const memories = makeMemories("hi");
    const result = compiler.compile(memories, { actorId: "a", maxTokens: 5000 });
    expect(result.recentMemories.length + result.importantMemories.length).toBeGreaterThan(0);
  });

  it("estimates tokens correctly for non-prose text", () => {
    // Create a compiler instance to access the private method indirectly
    const compiler = new ContextCompiler();
    const longJson = JSON.stringify({ data: Array(50).fill("a") });
    const result = compiler.compile(
      [{ id: "m", actorId: "a", memoryType: "interaction", content: longJson, importance: 0.9, emotionalValence: 0, tags: [], createdAt: new Date() }],
      { actorId: "a", maxTokens: 5000 }
    );
    // Should estimate realistically (not just ~2 tokens), and fit within budget
    expect(result.tokenEstimate).toBeGreaterThan(10);
    expect(result.tokenEstimate).toBeLessThan(5000);
  });
});

// ── DiskStorageAdapter touch persistence ──

describe("DiskStorageAdapter touch persistence", () => {
  it("updates _touchedAt on disk after retrieve", async () => {
    const { DiskStorageAdapter } = await import("../src/adapters/storage/disk.js");
    const { mkdir, rm, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const dir = join(import.meta.dirname ?? process.cwd(), ".memstack-touch-test");
    await rm(dir, { recursive: true, force: true });

    const storage = new DiskStorageAdapter({ storageDir: dir });
    await storage.initialize();

    const mem = await storage.store({ actorId: "a", content: "touch test" });
    const originalRaw = JSON.parse(await readFile(join(dir, "a.json"), "utf-8"));
    const originalTouched = originalRaw[0]._touchedAt;

    // Wait a tick to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    await storage.retrieve({ actorId: "a", limit: 1 });

    const updatedRaw = JSON.parse(await readFile(join(dir, "a.json"), "utf-8"));
    const updatedTouched = updatedRaw[0]._touchedAt;
    expect(updatedTouched).not.toBe(originalTouched);

    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── touch() preserves identity ──

describe("MemoryStore touch preserves identity", () => {
  it("preserves id, content, importance, tags, and createdAt after touch (InMemoryStorageAdapter)", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });
    const mem = await store.store({
      actorId: "player1",
      content: "critical observation",
      importance: 0.9,
      tags: ["urgent"],
    });

    await store.touch(mem.id);

    const reloaded = await store.get(mem.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.id).toBe(mem.id);
    expect(reloaded!.content).toBe(mem.content);
    expect(reloaded!.importance).toBe(mem.importance);
    expect(reloaded!.tags).toEqual(mem.tags);
    expect(reloaded!.createdAt.getTime()).toBe(mem.createdAt.getTime());
  });

  it("preserves id after touch in DiskStorage", async () => {
    const { DiskStorageAdapter } = await import("../src/adapters/storage/disk.js");
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const dir = join(import.meta.dirname ?? process.cwd(), ".memstack-touch-id-test");
    await rm(dir, { recursive: true, force: true });

    const storage = new DiskStorageAdapter({ storageDir: dir });
    await storage.initialize();
    const store = new MemoryStore({ storage });

    const mem = await store.store({
      actorId: "p2",
      content: "disk touch test",
      importance: 0.7,
      tags: ["disk"],
    });
    const originalId = mem.id;
    const originalCreatedAt = mem.createdAt.getTime();

    await store.touch(originalId);

    const reloaded = await store.get(originalId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.id).toBe(originalId);
    expect(reloaded!.content).toBe(mem.content);
    expect(reloaded!.importance).toBe(mem.importance);
    expect(reloaded!.tags).toEqual(mem.tags);
    expect(reloaded!.createdAt.getTime()).toBe(originalCreatedAt);

    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ── Pruner tests (via MemoryStore) ──

describe("Pruner (via MemoryStore)", () => {
  it("byAge: removes memories older than maxAge, keeps recent ones", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    // Store 5 memories and backdate some of them
    const old1 = await store.store({ actorId: "a", content: "old memory 1", importance: 0.5 });
    old1.createdAt = new Date(Date.now() - 3 * 86400000); // 3 days ago
    const old2 = await store.store({ actorId: "a", content: "old memory 2", importance: 0.5 });
    old2.createdAt = new Date(Date.now() - 2 * 86400000); // 2 days ago
    const old3 = await store.store({ actorId: "a", content: "old memory 3", importance: 0.5 });
    old3.createdAt = new Date(Date.now() - 36 * 3600000); // 36 hours ago

    // 2 recent memories — createdAt is ~now (set by InMemoryStorageAdapter)
    const recent1 = await store.store({ actorId: "a", content: "recent memory 1", importance: 0.5 });
    const recent2 = await store.store({ actorId: "a", content: "recent memory 2", importance: 0.5 });

    const result = await store.prune({ type: "byAge", maxAge: 86400000 }); // 1 day

    expect(result.count).toBe(3);
    expect(result.pruned).toHaveLength(3);

    const remaining = await store.export();
    expect(remaining).toHaveLength(2);
    const remainingIds = remaining.map((m) => m.id);
    expect(remainingIds).toContain(recent1.id);
    expect(remainingIds).toContain(recent2.id);
  });

  it("byImportance: removes memories below minImportance threshold", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    await store.store({ actorId: "a", content: "low #1", importance: 0.1 });
    await store.store({ actorId: "a", content: "low #2", importance: 0.3 });
    await store.store({ actorId: "a", content: "mid", importance: 0.5 });
    await store.store({ actorId: "a", content: "high #1", importance: 0.7 });
    await store.store({ actorId: "a", content: "high #2", importance: 0.9 });

    const result = await store.prune({ type: "byImportance", minImportance: 0.5 });

    expect(result.count).toBe(2);
    expect(result.pruned).toHaveLength(2);

    const remaining = await store.export();
    expect(remaining).toHaveLength(3);
    const importances = remaining.map((m) => m.importance).sort();
    expect(importances).toEqual([0.5, 0.7, 0.9]);
  });

  it("scopes prune to strategy.actorId — never deletes another actor's memories", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    await store.store({ actorId: "alice", content: "alice low importance", importance: 0.1 });
    await store.store({ actorId: "bob", content: "bob low importance too", importance: 0.1 });

    const result = await store.prune({ type: "byImportance", minImportance: 0.5, actorId: "alice" });

    expect(result.count).toBe(1);
    const remaining = await store.export();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].actorId).toBe("bob");
  });

  it("dryRunPrune scopes to strategy.actorId the same way as prune", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    await store.store({ actorId: "alice", content: "alice low importance", importance: 0.1 });
    await store.store({ actorId: "bob", content: "bob low importance too", importance: 0.1 });

    const result = await store.dryRunPrune({ type: "byImportance", minImportance: 0.5, actorId: "alice" });

    expect(result.count).toBe(1);
    const remaining = await store.export();
    expect(remaining).toHaveLength(2); // dry run — nothing actually deleted
  });

  it("byImportance: defaults to minImportance 0.5 when not specified", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    await store.store({ actorId: "a", content: "low", importance: 0.2 });
    await store.store({ actorId: "a", content: "high", importance: 0.8 });

    const result = await store.prune({ type: "byImportance" });

    expect(result.count).toBe(1);
    const remaining = await store.export();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe("high");
  });

  it("byCount: caps per-actor memory count, keeping highest importance", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    // 10 memories for actor "a" with varying importance
    for (let i = 0; i < 10; i++) {
      await store.store({ actorId: "a", content: `a-${i}`, importance: 0.1 + i * 0.08 });
    }
    // 3 memories for actor "b"
    for (let i = 0; i < 3; i++) {
      await store.store({ actorId: "b", content: `b-${i}`, importance: 0.5 + i * 0.1 });
    }

    const result = await store.prune({ type: "byCount", maxPerActor: 3 });

    // "a" had 10, keeps 3 → 7 removed. "b" had 3, keeps 3 → 0 removed. Total = 7.
    expect(result.count).toBe(7);
    expect(result.pruned).toHaveLength(7);

    const remaining = await store.export();
    expect(remaining).toHaveLength(6); // 3 for "a" + 3 for "b"

    const aMemories = remaining.filter((m) => m.actorId === "a");
    const bMemories = remaining.filter((m) => m.actorId === "b");
    expect(aMemories).toHaveLength(3);
    expect(bMemories).toHaveLength(3);

    // Verify "a" kept the 3 highest importance ones
    const aImportances = aMemories.map((m) => m.importance).sort();
    expect(aImportances[0]).toBeGreaterThanOrEqual(0.6);
    expect(aImportances[2]).toBeGreaterThan(0.8);
  });

  it("byType: removes only the specified memory types", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    await store.store({ actorId: "a", content: "interaction 1", memoryType: "interaction" });
    await store.store({ actorId: "a", content: "interaction 2", memoryType: "interaction" });
    await store.store({ actorId: "a", content: "interaction 3", memoryType: "interaction" });
    await store.store({ actorId: "a", content: "observation 1", memoryType: "observation" });
    await store.store({ actorId: "a", content: "observation 2", memoryType: "observation" });

    const result = await store.prune({ type: "byType", memoryTypes: ["observation"] });

    expect(result.count).toBe(2);
    expect(result.pruned).toHaveLength(2);

    const remaining = await store.export();
    expect(remaining).toHaveLength(3);
    const remainingTypes = remaining.map((m) => m.memoryType);
    expect(remainingTypes.every((t) => t === "interaction")).toBe(true);
  });

  it("byType: keeps all when memoryTypes is empty array", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    await store.store({ actorId: "a", content: "interaction", memoryType: "interaction" });
    await store.store({ actorId: "a", content: "observation", memoryType: "observation" });

    const result = await store.prune({ type: "byType", memoryTypes: [] });

    expect(result.count).toBe(0);
    expect(result.pruned).toHaveLength(0);

    const remaining = await store.export();
    expect(remaining).toHaveLength(2);
  });

  it("custom: removes memories matching the shouldRemove predicate", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    const keep1 = await store.store({ actorId: "a", content: "important data", importance: 0.9 });
    const remove1 = await store.store({ actorId: "a", content: "please delete this", importance: 0.5 });
    const keep2 = await store.store({ actorId: "a", content: "archive record", importance: 0.7 });
    const remove2 = await store.store({ actorId: "a", content: "delete all logs", importance: 0.3 });

    const result = await store.prune({
      type: "custom",
      shouldRemove: (m) => m.content.includes("delete"),
    });

    expect(result.count).toBe(2);
    expect(result.pruned).toHaveLength(2);
    expect(result.pruned).toContain(remove1.id);
    expect(result.pruned).toContain(remove2.id);

    const remaining = await store.export();
    expect(remaining).toHaveLength(2);
    const remainingIds = remaining.map((m) => m.id);
    expect(remainingIds).toContain(keep1.id);
    expect(remainingIds).toContain(keep2.id);
  });

  it("custom: keeps all when predicate returns false for everything", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    await store.store({ actorId: "a", content: "record 1" });
    await store.store({ actorId: "a", content: "record 2" });

    const result = await store.prune({
      type: "custom",
      shouldRemove: () => false,
    });

    expect(result.count).toBe(0);
    expect(result.pruned).toHaveLength(0);

    const remaining = await store.export();
    expect(remaining).toHaveLength(2);
  });

  it("empty prune: returns empty result when no memories in store", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    const result = await store.prune({ type: "byAge", maxAge: 86400000 });

    expect(result.count).toBe(0);
    expect(result.pruned).toEqual([]);
  });

  it("dryRunPrune: reports what would be removed without deleting", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    await store.store({ actorId: "a", content: "low", importance: 0.1 });
    await store.store({ actorId: "a", content: "high", importance: 0.9 });
    await store.store({ actorId: "a", content: "mid", importance: 0.5 });

    const dry = await store.dryRunPrune({ type: "byImportance", minImportance: 0.5 });

    expect(dry.count).toBe(1);
    expect(dry.wouldPrune).toHaveLength(1);

    // Verify nothing was actually deleted
    const stillThere = await store.count();
    expect(stillThere).toBe(3);
  });
});

// ── Summarizer edge case ──

describe("Summarizer edge cases", () => {
  it("throws VALIDATION_ERROR when no memories to summarize", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage, llm: mockLLM as never });

    await expect(
      store.summarize({ actorId: "nonexistent" })
    ).rejects.toThrow("No memories to summarize");
  });

  it("throws VALIDATION_ERROR when no LLM configured", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    await store.store({ actorId: "a", content: "some memory" });

    await expect(
      store.summarize({ actorId: "a" })
    ).rejects.toThrow("No LLM configured for summarization");
  });
});

// ── MemoryStore edge cases ──

describe("MemoryStore edge cases", () => {
  it("storeBatch with empty array returns empty array", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    const results = await store.storeBatch([]);

    expect(results).toEqual([]);
    expect(await store.count()).toBe(0);
  });
});

// ── ContextCompiler edge cases ──

describe("ContextCompiler edge cases", () => {
  it("compileContext with zero memories returns empty prompt and empty arrays", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });

    const ctx = await store.compileContext({ actorId: "empty" });

    expect(ctx.systemPrompt).toBe("");
    expect(ctx.recentMemories).toEqual([]);
    expect(ctx.importantMemories).toEqual([]);
    expect(ctx.tokenEstimate).toBeGreaterThanOrEqual(0);
  });
});

// ── Time range filter ──

describe("time range filter", () => {
  it("createdAfter filters older memories", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });
    const old = await store.store({ actorId: "a", content: "old" });
    old.createdAt = new Date(Date.now() - 5000);
    await store.store({ actorId: "a", content: "new" });
    const cutoff = new Date(Date.now() - 2000);
    const results = await store.retrieve({ actorId: "a", createdAfter: cutoff });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("new");
  });

  it("createdBefore filters newer memories", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });
    await store.store({ actorId: "a", content: "before" });
    const newMem = await store.store({ actorId: "a", content: "after" });
    newMem.createdAt = new Date(Date.now() + 5000);
    const cutoff = new Date(Date.now() + 1000);
    const results = await store.retrieve({ actorId: "a", createdBefore: cutoff });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("before");
  });

  it("both createdAfter and createdBefore together", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });
    const old = await store.store({ actorId: "a", content: "too-old" });
    old.createdAt = new Date(Date.now() - 5000);
    await store.store({ actorId: "a", content: "in-range" });
    const tooNew = await store.store({ actorId: "a", content: "too-new" });
    tooNew.createdAt = new Date(Date.now() + 5000);
    const results = await store.retrieve({
      actorId: "a",
      createdAfter: new Date(Date.now() - 2000),
      createdBefore: new Date(Date.now() + 2000),
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("in-range");
  });
});

// ── Compose prune ──

describe("compose prune strategy", () => {
  it("keeps memories passing ALL sub-strategies", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage });
    const mem1 = await store.store({ actorId: "a", content: "old and low", importance: 0.2 });
    mem1.createdAt = new Date(Date.now() - 3 * 86400000);
    const mem2 = await store.store({ actorId: "a", content: "old and high", importance: 0.9 });
    mem2.createdAt = new Date(Date.now() - 3 * 86400000);
    await store.store({ actorId: "a", content: "new and high", importance: 0.9 });

    const result = await store.prune({
      type: "compose",
      strategies: [
        { type: "byAge", maxAge: 86400000 },
        { type: "byImportance", minImportance: 0.5 },
      ],
    });
    expect(result.count).toBe(2);
  });
});

// ── Summarize stream ──

describe("summarizeStream", () => {
  it("falls back to non-streaming when LLM lacks completeStream", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage, llm: mockLLM as never });
    await store.store({ actorId: "a", content: "memory one" });
    await store.store({ actorId: "a", content: "memory two" });
    const chunks: { chunk: string; text: string }[] = [];
    for await (const chunk of store.summarizeStream({ actorId: "a" })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1].text).toBeTruthy();
  });

  it("throws when no memories to summarize", async () => {
    const storage = new InMemoryStorageAdapter();
    const store = new MemoryStore({ storage, llm: mockLLM as never });
    await expect(async () => {
      for await (const _ of store.summarizeStream({ actorId: "nonexistent" })) { /* */ }
    }).rejects.toThrow("No memories to summarize");
  });
});
