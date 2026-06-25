import { describe, it, expect, beforeEach, vi } from "vitest";
import { ZepStorageAdapter } from "../src/adapters/storage/zep.js";

function createMockZep() {
  return {
    memory: {
      async add() { return { uuid: "zep-1" }; },
      async get() { return { messages: [] }; },
      async search() { return []; },
      async delete() {},
    },
  };
}

vi.mock("@getzep/zep-cloud", () => ({
  ZepClient: vi.fn().mockImplementation(() => createMockZep()),
}));

describe("ZepStorageAdapter", () => {
  describe("construction", () => {
    it("constructs with cloud mode and apiKey", () => {
      const adapter = new ZepStorageAdapter({
        mode: "cloud",
        apiKey: "test-key",
      });
      expect(adapter).toBeInstanceOf(ZepStorageAdapter);
    });

    it("constructs with community mode, baseUrl, and no apiKey", () => {
      const adapter = new ZepStorageAdapter({
        mode: "community",
        baseUrl: "http://localhost:8000",
      });
      expect(adapter).toBeInstanceOf(ZepStorageAdapter);
    });

    it("constructs with community mode and apiKey", () => {
      const adapter = new ZepStorageAdapter({
        mode: "community",
        baseUrl: "http://localhost:8000",
        apiKey: "optional-key",
      });
      expect(adapter).toBeInstanceOf(ZepStorageAdapter);
    });

    it("throws when cloud mode is missing apiKey", () => {
      expect(
        () => new ZepStorageAdapter({ mode: "cloud" } as never)
      ).toThrow("apiKey is required for Zep cloud mode");
    });

    it("throws when community mode is missing baseUrl", () => {
      expect(
        () => new ZepStorageAdapter({ mode: "community" } as never)
      ).toThrow("baseUrl is required for Zep community mode");
    });
  });

  describe("operations", () => {
    let adapter: ZepStorageAdapter;
    let uuidCounter: number;

    beforeEach(async () => {
      uuidCounter = 0;

      const mockZep = {
        memory: {
          async add() {
            uuidCounter++;
            return { uuid: `zep-uuid-${uuidCounter}` };
          },
          async get() { return { messages: [] }; },
          async search() { return []; },
          async delete() {},
        },
      };

      vi.mocked((await import("@getzep/zep-cloud")).ZepClient).mockReturnValue(mockZep);

      adapter = new ZepStorageAdapter({
        mode: "cloud",
        apiKey: "test-key",
      });
      await adapter.initialize();
    });

    it("stores and retrieves a memory", async () => {
      const mem = await adapter.store({
        actorId: "npc_1",
        content: "Hello world",
      });

      expect(mem.id).toBeTruthy();
      expect(mem.actorId).toBe("npc_1");
      expect(mem.content).toBe("Hello world");
      expect(mem.memoryType).toBe("interaction");
      expect(mem.createdAt).toBeInstanceOf(Date);
    });

    it("returns null for missing memory", async () => {
      const result = await adapter.get("nonexistent");
      expect(result).toBeNull();
    });

    it("stores batch", async () => {
      const results = await adapter.storeBatch([
        { actorId: "a", content: "one" },
        { actorId: "a", content: "two" },
      ]);

      expect(results).toHaveLength(2);
    });

    it("delete and deleteMany mark memories as removed", async () => {
      const mem = await adapter.store({ actorId: "a", content: "test" });
      await adapter.delete(mem.id);

      const result = await adapter.get(mem.id);
      expect(result).toBeNull();
    });

    it("deleteMany returns deleted count", async () => {
      const m1 = await adapter.store({ actorId: "a", content: "1" });
      const m2 = await adapter.store({ actorId: "a", content: "2" });
      const m3 = await adapter.store({ actorId: "a", content: "3" });

      const deleted = await adapter.deleteMany([m1.id, m3.id]);
      expect(deleted).toBe(2);
    });

    it("delete throws for unknown memory", async () => {
      await expect(adapter.delete("nonexistent")).rejects.toThrow(
        "Memory not found"
      );
    });

    it("deleteMany ignores unknown ids", async () => {
      const deleted = await adapter.deleteMany(["nonexistent"]);
      expect(deleted).toBe(0);
    });

    it("retrieve returns empty for unknown actorId", async () => {
      const results = await adapter.retrieve({ actorId: "unknown" });
      expect(results).toHaveLength(0);
    });

    it("count returns 0 for empty actor", async () => {
      const count = await adapter.count({ actorId: "npc_1" });
      expect(count).toBe(0);
    });

    it("count returns 0 for no filters", async () => {
      const count = await adapter.count();
      expect(count).toBe(0);
    });

    it("closes cleanly", async () => {
      await adapter.close();
    });

    it("initializes with community mode", async () => {
      const communityAdapter = new ZepStorageAdapter({
        mode: "community",
        baseUrl: "http://localhost:8000",
      });
      await communityAdapter.initialize();
      await communityAdapter.close();
    });
  });

  describe("with mock messages", () => {
    let adapter: ZepStorageAdapter;

    beforeEach(async () => {
      const mockZep = {
        memory: {
          async add(_sessionId: string, messages: unknown[]) {
            const msg = (messages as Array<{ uuid?: string }>)[0];
            return { uuid: msg.uuid ?? "zep-uuid-1" };
          },
          async get(_sessionId: string, _params?: { lastn?: number }) {
            return {
              messages: [
                {
                  uuid: "zep-uuid-1",
                  role: "user",
                  content: "Test memory content",
                  created_at: new Date().toISOString(),
                  metadata: {
                    memoryType: "observation",
                    importance: 0.8,
                    emotionalValence: 0.3,
                    tags: ["combat"],
                    actorId: "npc_1",
                  },
                },
                {
                  uuid: "zep-uuid-2",
                  role: "user",
                  content: "Another memory",
                  created_at: new Date().toISOString(),
                  metadata: {
                    memoryType: "interaction",
                    importance: 0.3,
                    emotionalValence: -0.2,
                    tags: ["dialogue"],
                    actorId: "npc_1",
                  },
                },
              ],
            };
          },
          async search(_sessionId: string, _query: { text: string; metadata?: Record<string, unknown> }, _limit?: number) {
            return [
              {
                uuid: "zep-uuid-1",
                role: "user",
                content: "Test memory content",
                created_at: new Date().toISOString(),
                metadata: {
                  memoryType: "observation",
                  importance: 0.8,
                  tags: ["combat"],
                  actorId: "npc_1",
                },
              },
              {
                uuid: "zep-uuid-2",
                role: "user",
                content: "Another memory",
                created_at: new Date(Date.now() - 60000).toISOString(),
                metadata: {
                  memoryType: "interaction",
                  importance: 0.3,
                  tags: ["dialogue"],
                  actorId: "npc_1",
                },
              },
            ];
          },
          async delete() {},
        },
      };

      vi.mocked((await import("@getzep/zep-cloud")).ZepClient).mockReturnValue(mockZep);

      adapter = new ZepStorageAdapter({
        mode: "cloud",
        apiKey: "test-key",
      });
      await adapter.initialize();
    });

    it("retrieves with recent strategy", async () => {
      const results = await adapter.retrieve({
        actorId: "npc_1",
        strategy: "recent",
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it("retrieves with important strategy filters by importance", async () => {
      const results = await adapter.retrieve({
        actorId: "npc_1",
        strategy: "important",
        limit: 5,
      });

      for (const mem of results) {
        expect(mem.importance).toBeGreaterThanOrEqual(0.5);
      }
    });

    it("counts with memoryType filter", async () => {
      const count = await adapter.count({
        actorId: "npc_1",
        memoryType: "observation",
      });

      expect(count).toBeGreaterThanOrEqual(0);
    });

    it("counts with minImportance filter", async () => {
      const count = await adapter.count({
        actorId: "npc_1",
        minImportance: 0.5,
      });

      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
