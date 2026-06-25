import { ChromaStorageAdapter } from "../src/adapters/storage/chroma.js";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { passed++; console.log(`  OK: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

try {
  const chromadb = await import("chromadb");
  const { ChromaClient } = (chromadb.default ?? chromadb) as { ChromaClient: new (opts?: Record<string, unknown>) => never };

  const client = new ChromaClient();
  const collName = `e2e_${Date.now().toString(36)}`;
  const collection = await client.getOrCreateCollection({
    name: collName,
    embeddingFunction: undefined as never,
  // @ts-expect-error ChromaDB v3 wants embedding function but we bypass
  } as never) as never;

  const adapter = new ChromaStorageAdapter({ collection: collection as never });

  console.log("\nChromaStorageAdapter — E2E\n");

  const mem = await adapter.store({ actorId: "c", content: "Chroma works", importance: 0.9, tags: ["e2e"] });
  check("store", mem.id.startsWith("mem_"));
  check("get", (await adapter.get(mem.id))?.content === "Chroma works");
  check("get null", (await adapter.get("x")) === null);

  await adapter.store({ actorId: "c", content: "high", importance: 0.9 });
  await adapter.store({ actorId: "c", content: "low", importance: 0.2 });
  check("important", (await adapter.retrieve({ actorId: "c", strategy: "important", limit: 1 }))[0]?.importance === 0.9);
  check("recent", (await adapter.retrieve({ actorId: "c", strategy: "recent" })).length >= 3);
  check("count", (await adapter.count()) >= 3);

  const batch = await adapter.storeBatch([{ actorId: "c", content: "B1" }, { actorId: "c", content: "B2" }]);
  check("batch", batch.length === 2);
  check("deleteMany", (await adapter.deleteMany([batch[0].id, batch[1].id])) === 2);
  await adapter.delete(mem.id);
  check("delete", (await adapter.get(mem.id)) === null);

  try { await (client as { deleteCollection: (o: { name: string }) => Promise<void> }).deleteCollection({ name: collName }); } catch {}

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed > 0 ? 1 : 0);
} catch (e: unknown) {
  const msg = (e as Error).message ?? String(e);
  if (msg.toLowerCase().includes("chromadb") || msg.includes("Cannot find")) {
    console.log("\nChromaStorageAdapter — E2E\n  SKIPPED: chromadb not available");
    process.exit(0);
  }
  throw e;
}
