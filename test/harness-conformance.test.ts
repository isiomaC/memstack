import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStorageAdapter } from "../src/adapters/storage/memory.js";
import { DiskStorageAdapter } from "../src/adapters/storage/disk.js";
import { SQLiteStorageAdapter } from "../src/adapters/storage/sqlite.js";
import { runHarnessConformance } from "./harness/conformance.js";

runHarnessConformance("memory", async () => ({ storage: new InMemoryStorageAdapter() }));

runHarnessConformance("disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memstack-disk-"));
  return {
    storage: new DiskStorageAdapter({ storageDir: dir }),
    teardown: async () => rmSync(dir, { recursive: true, force: true }),
  };
});

let Database: (new (filename: string) => unknown) | undefined;
try {
  Database = (await import("better-sqlite3")).default as unknown as new (filename: string) => unknown;
} catch {
  Database = undefined;
}

if (Database) {
  runHarnessConformance("sqlite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memstack-sqlite-"));
    const storage = new SQLiteStorageAdapter({ db: new Database!(join(dir, "memstack.db")) as never });
    return {
      storage,
      teardown: async () => {
        await storage.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  });
}
