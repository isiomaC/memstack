import { SQLiteStorageAdapter } from "../src/adapters/storage/sqlite.js";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { passed++; console.log(`  OK: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

try {
  const BetterSqlite3 = (await import("better-sqlite3")).default as new (path: string) => never;
  const db = new BetterSqlite3(":memory:");
  const adapter = new SQLiteStorageAdapter({ db: db as never });
  await adapter.initialize();

  console.log("\nSQLiteStorageAdapter — E2E\n");

  const mem = await adapter.store({
    actorId: "sqlite-e2e",
    content: "SQLite E2E test",
    importance: 0.9,
    tags: ["sqlite", "e2e"],
    metadata: { session: "abc" },
  });
  check("store creates memory", mem.id.startsWith("mem_"));
  check("get returns correct", (await adapter.get(mem.id))?.content === "SQLite E2E test");
  check("get null on missing", (await adapter.get("x")) === null);

  await adapter.store({ actorId: "sqlite-e2e", content: "high", importance: 0.9 });
  await adapter.store({ actorId: "sqlite-e2e", content: "low", importance: 0.2 });
  check("important strategy", (await adapter.retrieve({ actorId: "sqlite-e2e", strategy: "important", limit: 1 }))[0]?.importance === 0.9);
  check("recent strategy", (await adapter.retrieve({ actorId: "sqlite-e2e", strategy: "recent" })).length >= 3);
  check("count", (await adapter.count({ actorId: "sqlite-e2e" })) >= 3);

  await adapter.touch(mem.id);
  check("touch succeeds", true);

  const batch = await adapter.storeBatch([{ actorId: "sqlite-e2e", content: "B1" }, { actorId: "sqlite-e2e", content: "B2" }]);
  check("batch", batch.length === 2);
  check("deleteMany", (await adapter.deleteMany([batch[0].id, batch[1].id])) === 2);
  await adapter.delete(mem.id);
  check("delete", (await adapter.get(mem.id)) === null);

  db.close();

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed > 0 ? 1 : 0);
} catch (e: unknown) {
  const msg = (e as Error).message ?? String(e);
  if (msg.toLowerCase().includes("better-sqlite3") || msg.includes("Cannot find")) {
    console.log("\nSQLiteStorageAdapter — E2E\n  SKIPPED: better-sqlite3 not available");
    process.exit(0);
  }
  throw e;
}
