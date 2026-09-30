import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteStorageAdapter, SQLITE_SCHEMA_VERSION } from "../src/adapters/storage/sqlite.js";

type Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  pragma(sql: string, options?: { simple: boolean }): unknown;
  close(): void;
};

let Database: (new (filename: string) => Db) | undefined;
try {
  Database = (await import("better-sqlite3")).default as unknown as new (filename: string) => Db;
} catch {
  Database = undefined;
}

describe.skipIf(!Database)("SQLiteStorageAdapter foundation", () => {
  let dir: string;
  let dbPath: string;
  const open: Db[] = [];

  function connect(): Db {
    const db = new Database!(dbPath);
    open.push(db);
    return db;
  }

  async function adapterFor(db: Db, tableName?: string): Promise<SQLiteStorageAdapter> {
    const adapter = new SQLiteStorageAdapter({ db: db as never, tableName });
    await adapter.initialize();
    return adapter;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memstack-sqlite-"));
    dbPath = join(dir, "memstack.db");
  });

  afterEach(() => {
    for (const db of open.splice(0)) {
      try {
        db.close();
      } catch {
        // already closed by the adapter
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  describe("connection setup", () => {
    it("enables WAL and a busy timeout", async () => {
      const db = connect();
      await adapterFor(db);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    });

    it("honours busyTimeoutMs and walMode: false", async () => {
      const db = connect();
      const adapter = new SQLiteStorageAdapter({ db: db as never, busyTimeoutMs: 250, walMode: false });
      await adapter.initialize();
      expect(db.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(250);
    });

    it("rejects an invalid busyTimeoutMs", () => {
      expect(() => new SQLiteStorageAdapter({ db: connect() as never, busyTimeoutMs: -1 })).toThrow(/busyTimeoutMs/);
    });
  });

  describe("migrations", () => {
    it("records the latest schema version and is idempotent", async () => {
      const db = connect();
      const adapter = await adapterFor(db);
      await adapter.store({ actorId: "p", content: "kept across re-initialize" });
      await adapter.initialize();

      expect(adapter.schemaVersion()).toBe(SQLITE_SCHEMA_VERSION);
      expect(await adapter.count()).toBe(1);
      expect((await adapter.retrieve({ actorId: "p" })).map((m) => m.content)).toEqual(["kept across re-initialize"]);
    });

    it("adopts a pre-migration database without touching its rows", async () => {
      const db = connect();
      // Schema written by MemStack 0.7.x, before migrations existed.
      db.exec(`
        CREATE TABLE memstack_memories (
          id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, memory_type TEXT NOT NULL DEFAULT 'interaction',
          content TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, emotional_valence REAL NOT NULL DEFAULT 0,
          tags TEXT NOT NULL DEFAULT '[]', embedding TEXT, source_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
          expires_at TEXT, created_at TEXT NOT NULL, touched_at TEXT NOT NULL
        )
      `);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO memstack_memories (id, actor_id, content, tags, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run("legacy-1", "p", "This project uses Hono", '["framework"]', now, now);

      const adapter = await adapterFor(db);

      expect(adapter.schemaVersion()).toBe(SQLITE_SCHEMA_VERSION);
      expect((await adapter.get("legacy-1"))?.content).toBe("This project uses Hono");
    });

    it("tracks versions per table so adapters can share a file", async () => {
      const db = connect();
      const first = await adapterFor(db, "first_memories");
      const second = await adapterFor(db, "second_memories");
      await first.store({ actorId: "p", content: "only in first" });

      expect(first.schemaVersion()).toBe(SQLITE_SCHEMA_VERSION);
      expect(second.schemaVersion()).toBe(SQLITE_SCHEMA_VERSION);
      expect(await second.count()).toBe(0);
    });
  });

  describe("reads without side effects", () => {
    it("does not mark memories as accessed when touch is false", async () => {
      const db = connect();
      const adapter = await adapterFor(db);
      await adapter.store({ id: "m1", actorId: "p", content: "untouched" });
      const before = db.prepare("SELECT touched_at FROM memstack_memories WHERE id = 'm1'").get();
      await new Promise((r) => setTimeout(r, 5));

      await adapter.retrieve({ actorId: "p", touch: false });
      expect(db.prepare("SELECT touched_at FROM memstack_memories WHERE id = 'm1'").get()).toEqual(before);

      await adapter.retrieve({ actorId: "p" });
      expect(db.prepare("SELECT touched_at FROM memstack_memories WHERE id = 'm1'").get()).not.toEqual(before);
    });
  });

  describe("transactions", () => {
    it("rolls back the whole batch when one write fails", async () => {
      const adapter = await adapterFor(connect());
      await expect(
        adapter.storeBatch([
          { actorId: "p", content: "first" },
          { actorId: "p", content: null as unknown as string },
        ])
      ).rejects.toThrow();
      expect(await adapter.count()).toBe(0);

      await adapter.storeBatch([{ actorId: "p", content: "after rollback" }]);
      expect(await adapter.count()).toBe(1);
    });
  });

  describe("concurrent processes", () => {
    const writer = fileURLToPath(new URL("./fixtures/sqlite-writer.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

    function runWriter(actorId: string, count: number): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [tsx, writer, dbPath, actorId, String(count)], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`writer ${actorId} exited ${code}: ${stderr}`))
        );
      });
    }

    it("two processes initialize and write the same file without losing data", async () => {
      const perProcess = 200;
      await Promise.all([runWriter("claude-code", perProcess), runWriter("codex", perProcess)]);

      const db = connect();
      const adapter = await adapterFor(db);
      expect(await adapter.count({ actorId: "claude-code" })).toBe(perProcess * 2);
      expect(await adapter.count({ actorId: "codex" })).toBe(perProcess * 2);
      expect(adapter.schemaVersion()).toBe(SQLITE_SCHEMA_VERSION);
    }, 60_000);
  });
});
