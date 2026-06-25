import { LanceDBStorageAdapter } from "../src/adapters/storage/lancedb.js";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { passed++; console.log(`  OK: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

try {
  const lancedb = await import("vectordb");
  const db = await lancedb.connect("/tmp/memstack-e2e-lancedb");
  const tableName = `e2e_${Date.now()}`;
  const adapter = new LanceDBStorageAdapter({ connection: db as never, tableName });

  console.log("\nLanceDBStorageAdapter — E2E\n");

  const table = await db.createTable(tableName, [{
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

  await adapter.initialize();

  const emb = Array(1536).fill(0).map(() => Math.random());
  const mem = await adapter.store({
    actorId: "lancedb-e2e",
    content: "LanceDB E2E test",
    importance: 0.9,
    tags: ["lancedb", "e2e"],
    embedding: emb,
    metadata: { k: "v" },
  });
  check("store creates memory", mem.id.startsWith("mem_"));
  check("store preserves content", mem.content === "LanceDB E2E test");

  const retrieved = await adapter.get(mem.id);
  check("get returns correct memory", retrieved?.id === mem.id);
  check("get returns null for missing", (await adapter.get("nonexistent")) === null);

  const semResults = await adapter.retrieve({ actorId: "lancedb-e2e", strategy: "semantic" });
  check("semantic retrieve returns results", semResults.length >= 1);

  await adapter.store({ actorId: "lancedb-e2e", content: "high", importance: 0.9, embedding: emb });
  await adapter.store({ actorId: "lancedb-e2e", content: "low", importance: 0.2, embedding: emb });
  const important = await adapter.retrieve({ actorId: "lancedb-e2e", strategy: "important", limit: 1 });
  check("important strategy returns highest", important[0]?.importance === 0.9);

  const count = await adapter.count({ actorId: "lancedb-e2e" });
  check("count by actor", count >= 3);

  const batch = await adapter.storeBatch([
    { actorId: "lancedb-e2e", content: "B1", embedding: emb },
    { actorId: "lancedb-e2e", content: "B2", embedding: emb },
  ]);
  check("batch store works", batch.length === 2);

  const delCount = await adapter.deleteMany([batch[0].id, batch[1].id]);
  check("deleteMany works", delCount === 2);

  await adapter.delete(mem.id);
  check("delete removes memory", (await adapter.get(mem.id)) === null);

  await db.dropTable(tableName);
} catch (e: unknown) {
  const msg = (e as Error).message ?? String(e);
  if (msg.includes("Cannot find") || msg.includes("vectordb")) {
    console.log("\nLanceDBStorageAdapter — E2E\n  SKIPPED: vectordb not installed");
    process.exit(0);
  }
  throw e;
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
