// Child process for the concurrent-writer test: opens its own connection to
// a shared SQLite file, initializes the adapter, and writes memories.
import Database from "better-sqlite3";
import { SQLiteStorageAdapter } from "../../src/adapters/storage/sqlite.js";

const [dbPath, actorId, countArg] = process.argv.slice(2);
const count = Number(countArg);

const adapter = new SQLiteStorageAdapter({ db: new Database(dbPath) as never });
await adapter.initialize();

for (let i = 0; i < count; i++) {
  await adapter.store({ actorId, content: `${actorId} single write ${i}`, tags: ["concurrency"] });
}
for (let i = 0; i < count; i += 10) {
  await adapter.storeBatch(
    Array.from({ length: 10 }, (_, j) => ({ actorId, content: `${actorId} batch write ${i + j}` }))
  );
}
await adapter.retrieve({ actorId, query: "write" });

await adapter.close();
