import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryStorageAdapter } from "../src/adapters/storage/memory.js";
import { LexicalRetriever } from "../src/retrieval/LexicalRetriever.js";
import type { Memory } from "../src/types.js";
import type { StorageProvider, TextSearchQuery } from "../src/interfaces.js";

describe("LexicalRetriever", () => {
  let storage: InMemoryStorageAdapter;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    await storage.initialize();
  });

  it("matches a prefix of a longer word", async () => {
    await storage.store({ actorId: "p", content: "This project uses Hono" });
    const { hits } = await new LexicalRetriever(storage).recall({ actorIds: ["p"], query: "hon" });
    expect(hits.map((h) => h.memory.content)).toEqual(["This project uses Hono"]);
  });

  it("ranks exact matches above prefix matches", async () => {
    await storage.store({ actorId: "p", content: "Configuring the router" });
    await storage.store({ actorId: "p", content: "Configure logging" });
    const { hits } = await new LexicalRetriever(storage).recall({ actorIds: ["p"], query: "configure" });
    expect(hits[0].memory.content).toBe("Configure logging");
  });

  it("filters by memory type", async () => {
    await storage.store({ actorId: "p", content: "Hono is the framework", memoryType: "fact" });
    await storage.store({ actorId: "p", content: "Asked about Hono", memoryType: "interaction" });
    const { hits } = await new LexicalRetriever(storage).recall({ actorIds: ["p"], query: "hono", memoryTypes: ["fact"] });
    expect(hits.map((h) => h.memory.content)).toEqual(["Hono is the framework"]);
  });

  it("returns the fallback for an empty query", async () => {
    await storage.store({ actorId: "p", content: "low", importance: 0.1 });
    await storage.store({ actorId: "p", content: "high", importance: 0.9 });
    const result = await new LexicalRetriever(storage).recall({ actorIds: ["p"] });
    expect(result.fallback).toBe(true);
    expect(result.hits.map((h) => h.memory.content)).toEqual(["high", "low"]);
  });

  it("de-duplicates repeated namespaces", async () => {
    await storage.store({ actorId: "p", content: "Hono" });
    const { hits } = await new LexicalRetriever(storage).recall({ actorIds: ["p", "p"], query: "hono" });
    expect(hits).toHaveLength(1);
  });

  describe("budgets", () => {
    it("caps the number of hits", async () => {
      for (let i = 0; i < 5; i++) await storage.store({ actorId: "p", content: `hono note ${i}` });
      const { hits } = await new LexicalRetriever(storage).recall({ actorIds: ["p"], query: "hono", limit: 3 });
      expect(hits).toHaveLength(3);
    });

    it("caps total characters but always returns the top hit", async () => {
      await storage.store({ actorId: "p", content: `hono ${"x".repeat(100)}`, importance: 0.9 });
      await storage.store({ actorId: "p", content: `hono ${"y".repeat(100)}`, importance: 0.5 });
      await storage.store({ actorId: "p", content: "hono short", importance: 0.1 });

      const { hits } = await new LexicalRetriever(storage).recall({ actorIds: ["p"], query: "hono", maxChars: 50 });
      expect(hits.map((h) => h.memory.importance)).toEqual([0.9]);

      const roomy = await new LexicalRetriever(storage).recall({ actorIds: ["p"], query: "hono", maxChars: 120 });
      expect(roomy.hits.map((h) => h.memory.importance)).toEqual([0.9, 0.1]);
    });
  });

  describe("access tracking", () => {
    it("loads candidates without touching them and touches only returned hits", async () => {
      await storage.store({ id: "hit", actorId: "p", content: "Hono" });
      await storage.store({ id: "miss", actorId: "p", content: "Zod" });
      const retrieve = vi.spyOn(storage, "retrieve");
      const touch = vi.spyOn(storage, "touch");

      await new LexicalRetriever(storage).recall({ actorIds: ["p"], query: "hono" });

      expect(retrieve.mock.calls.every(([q]) => q.touch === false)).toBe(true);
      expect(touch.mock.calls.map(([id]) => id)).toEqual(["hit"]);
    });

    it("does not touch when disabled", async () => {
      await storage.store({ actorId: "p", content: "Hono" });
      const touch = vi.spyOn(storage, "touch");
      await new LexicalRetriever(storage, { touch: false }).recall({ actorIds: ["p"], query: "hono" });
      expect(touch).not.toHaveBeenCalled();
    });

    it("ignores memories deleted before they could be touched", async () => {
      await storage.store({ actorId: "p", content: "Hono" });
      vi.spyOn(storage, "touch").mockRejectedValue(new Error("not found"));
      await expect(new LexicalRetriever(storage).recall({ actorIds: ["p"], query: "hono" })).resolves.toMatchObject({
        fallback: false,
      });
    });
  });

  describe("native search", () => {
    const memory: Memory = {
      id: "native", actorId: "p", memoryType: "fact", content: "Native result", importance: 0.5,
      emotionalValence: 0, tags: [], metadata: {}, createdAt: new Date(),
    };

    function nativeStorage(results: Memory[]): StorageProvider & { search: ReturnType<typeof vi.fn> } {
      const base = new InMemoryStorageAdapter();
      return Object.assign(base, {
        capabilities: { textSearch: true },
        search: vi.fn(async (_q: TextSearchQuery) => results.map((m) => ({ memory: m, score: 1 }))),
      });
    }

    it("uses the adapter's search when it declares textSearch", async () => {
      const native = nativeStorage([memory]);
      const { hits } = await new LexicalRetriever(native).recall({ actorIds: ["p", "global"], query: "native" });
      expect(native.search).toHaveBeenCalledWith(expect.objectContaining({ actorIds: ["p", "global"], query: "native" }));
      expect(hits.map((h) => h.memory.id)).toEqual(["native"]);
    });

    it("falls back to Core candidates when native search finds nothing", async () => {
      const native = nativeStorage([]);
      await native.store({ actorId: "p", content: "Stored memory" });
      const result = await new LexicalRetriever(native).recall({ actorIds: ["p"], query: "missing" });
      expect(result.fallback).toBe(true);
      expect(result.hits.map((h) => h.memory.content)).toEqual(["Stored memory"]);
    });

    it("ignores search() when textSearch is not declared", async () => {
      const native = nativeStorage([memory]);
      native.capabilities.textSearch = false;
      await native.store({ actorId: "p", content: "Core ranked" });
      const { hits } = await new LexicalRetriever(native).recall({ actorIds: ["p"], query: "core" });
      expect(native.search).not.toHaveBeenCalled();
      expect(hits.map((h) => h.memory.content)).toEqual(["Core ranked"]);
    });
  });
});
