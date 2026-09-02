import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LanceDBStorageAdapter } from "../src/adapters/storage/lancedb.js";

type LanceTable = {
  delete(predicate: string): Promise<void>;
};

type LanceConnection = {
  createTable(name: string, rows: Record<string, unknown>[]): Promise<LanceTable>;
  dropTable(name: string): Promise<void>;
};

type Connect = (path: string) => Promise<LanceConnection>;

let connect: Connect | undefined;
let unavailableReason = "vectordb is not available";

try {
  const lancedb = await import("vectordb");
  connect = lancedb.connect as Connect;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
  unavailableReason = "vectordb is not installed";
}

if (!connect) {
  console.warn(`LanceDBStorageAdapter E2E skipped: ${unavailableReason}`);
  describe("LanceDBStorageAdapter E2E", () => {
    it.skip(unavailableReason, () => {});
  });
} else {
  describe("LanceDBStorageAdapter E2E", () => {
    let directory: string;
    let connection: LanceConnection;
    let adapter: LanceDBStorageAdapter;
    const tableName = `memstack_e2e_${Date.now().toString(36)}`;
    const actorId = `lancedb-e2e-${Date.now().toString(36)}`;
    const embedding = Array.from({ length: 1536 }, (_, index) => index / 1536);

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "memstack-lancedb-e2e-"));
      connection = await connect!(directory);
      const table = await connection.createTable(tableName, [{
        id: "_init_",
        vector: Array(1536).fill(0),
        actor_id: "_",
        memory_type: "interaction",
        content: "",
        importance: 0,
        emotional_valence: 0,
        tags: "[]",
        source_id: "",
        metadata: "{}",
        expires_at: "",
        created_at: new Date().toISOString(),
      }]);
      await table.delete("id = '_init_'");
      adapter = new LanceDBStorageAdapter({ connection: connection as never, tableName });
      await adapter.initialize();
    });

    afterAll(async () => {
      if (connection) await connection.dropTable(tableName);
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("stores and gets a memory", async () => {
      const memory = await adapter.store({
        actorId,
        content: "LanceDB E2E test",
        importance: 0.9,
        tags: ["lancedb", "e2e"],
        embedding,
        metadata: { key: "value" },
      });

      expect(memory).toMatchObject({ content: "LanceDB E2E test" });
      expect(memory.id).toMatch(/^mem_/);
      await expect(adapter.get(memory.id)).resolves.toMatchObject({ id: memory.id });
    });

    it("returns null for a missing memory", async () => {
      await expect(adapter.get("missing-lancedb-memory")).resolves.toBeNull();
    });

    it("supports semantic retrieval", async () => {
      const results = await adapter.retrieve({ actorId, strategy: "semantic" }, embedding);
      expect(results.some(({ content }) => content === "LanceDB E2E test")).toBe(true);
    });

    it("returns the most important memory", async () => {
      await adapter.store({ actorId, content: "high", importance: 0.95, embedding });
      await adapter.store({ actorId, content: "low", importance: 0.2, embedding });

      const results = await adapter.retrieve({ actorId, strategy: "important", limit: 1 });
      expect(results[0]?.content).toBe("high");
    });

    it("counts memories by actor", async () => {
      await expect(adapter.count({ actorId })).resolves.toBe(3);
    });

    it("deleteMany removes only the requested batch", async () => {
      const original = await adapter.store({ actorId, content: "original", embedding });
      const batch = await adapter.storeBatch([
        { actorId, content: "B1", embedding },
        { actorId, content: "B2", embedding },
      ]);

      await expect(adapter.deleteMany(batch.map(({ id }) => id))).resolves.toBe(2);
      await expect(adapter.get(original.id)).resolves.toMatchObject({ id: original.id });
      await expect(Promise.all(batch.map(({ id }) => adapter.get(id)))).resolves.toEqual([null, null]);
    });

    it("deletes one memory", async () => {
      const memory = await adapter.store({ actorId, content: "delete me", embedding });
      await adapter.delete(memory.id);
      await expect(adapter.get(memory.id)).resolves.toBeNull();
    });
  });
}
