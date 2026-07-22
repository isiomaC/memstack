import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { ChromaStorageAdapter } from "../src/adapters/storage/chroma.js";

type ChromaClientInstance = {
  getOrCreateCollection(options: Record<string, unknown>): Promise<unknown>;
  deleteCollection(options: { name: string }): Promise<void>;
};

type ChromaClientConstructor = new (options?: Record<string, unknown>) => ChromaClientInstance;

type ChromaCapability =
  | { available: true; ChromaClient: ChromaClientConstructor }
  | { available: false; reason: "Chroma client unavailable" | "default embedding function unavailable" };

async function detectCapability(): Promise<ChromaCapability> {
  let ChromaClient: ChromaClientConstructor;
  try {
    const chromadb = await import("chromadb");
    ChromaClient = (chromadb.default ?? chromadb as unknown as { ChromaClient: ChromaClientConstructor }).ChromaClient;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      return { available: false, reason: "Chroma client unavailable" };
    }
    throw error;
  }

  const require = createRequire(import.meta.url);
  try {
    require.resolve("@chroma-core/default-embed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      return { available: false, reason: "default embedding function unavailable" };
    }
    throw error;
  }

  return { available: true, ChromaClient };
}

const capability = await detectCapability();

if (!capability.available) {
  console.warn(`ChromaStorageAdapter E2E skipped: ${capability.reason}`);
  describe("ChromaStorageAdapter E2E", () => {
    it.skip(capability.reason, () => {});
  });
} else {
describe("ChromaStorageAdapter E2E", () => {
  let client: ChromaClientInstance;
  let adapter: ChromaStorageAdapter;
  const actorId = `chroma-e2e-${Date.now().toString(36)}`;
  const collectionName = `memstack_e2e_${Date.now().toString(36)}`;

  beforeAll(async () => {
    client = new capability.ChromaClient();
    const collection = await client.getOrCreateCollection({ name: collectionName });
    adapter = new ChromaStorageAdapter({ collection: collection as never });
    await adapter.initialize();
  });

  afterAll(async () => {
    if (!client) return;
    await client.deleteCollection({ name: collectionName });
  });

  it("stores and gets a memory", async () => {
    const memory = await adapter.store({ actorId, content: "Chroma works", importance: 0.9, tags: ["e2e"] });

    expect(memory.id).toMatch(/^mem_/);
    await expect(adapter.get(memory.id)).resolves.toMatchObject({ id: memory.id, content: "Chroma works" });
  });

  it("returns null for a missing memory", async () => {
    await expect(adapter.get("missing-chroma-memory")).resolves.toBeNull();
  });

  it("supports important and recent retrieval", async () => {
    await adapter.store({ actorId, content: "high", importance: 0.9 });
    await adapter.store({ actorId, content: "low", importance: 0.2 });

    const important = await adapter.retrieve({ actorId, strategy: "important", limit: 1 });
    const recent = await adapter.retrieve({ actorId, strategy: "recent" });

    expect(important[0]?.importance).toBe(0.9);
    expect(recent).toHaveLength(3);
  });

  it("counts memories by actor", async () => {
    await expect(adapter.count({ actorId })).resolves.toBe(3);
  });

  it("stores and deletes a batch", async () => {
    const batch = await adapter.storeBatch([
      { actorId, content: "B1" },
      { actorId, content: "B2" },
    ]);

    expect(batch).toHaveLength(2);
    await expect(adapter.deleteMany(batch.map(({ id }) => id))).resolves.toBe(2);
    await expect(Promise.all(batch.map(({ id }) => adapter.get(id)))).resolves.toEqual([null, null]);
  });

  it("deletes one memory", async () => {
    const memory = await adapter.store({ actorId, content: "delete me" });
    await adapter.delete(memory.id);
    await expect(adapter.get(memory.id)).resolves.toBeNull();
  });
});
}
