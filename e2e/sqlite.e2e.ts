import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SQLiteStorageAdapter } from "../src/adapters/storage/sqlite.js";

interface SQLiteDatabase {
  close(): void;
}

type SQLiteConstructor = new (path: string) => SQLiteDatabase;

let BetterSqlite3: SQLiteConstructor | undefined;
let unavailableReason = "better-sqlite3 is not available";

try {
  BetterSqlite3 = (await import("better-sqlite3")).default as SQLiteConstructor;
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_DLOPEN_FAILED") {
    throw error;
  }
  unavailableReason = `better-sqlite3 is not available (${code})`;
}

const sqliteSuite = BetterSqlite3 ? describe : describe.skip;

sqliteSuite(`SQLiteStorageAdapter E2E — ${BetterSqlite3 ? "available" : unavailableReason}`, () => {
  let adapter: SQLiteStorageAdapter;
  let db: SQLiteDatabase;
  const actorId = `sqlite-e2e-${Date.now().toString(36)}`;

  beforeAll(async () => {
    db = new BetterSqlite3!(":memory:");
    adapter = new SQLiteStorageAdapter({ db: db as never });
    await adapter.initialize();
  });

  afterAll(() => {
    db?.close();
  });

  it("stores and gets a memory", async () => {
    const memory = await adapter.store({
      actorId,
      content: "SQLite E2E test",
      importance: 0.9,
      tags: ["sqlite", "e2e"],
      metadata: { session: "abc" },
    });

    expect(memory.id).toMatch(/^mem_/);
    await expect(adapter.get(memory.id)).resolves.toMatchObject({
      id: memory.id,
      content: "SQLite E2E test",
    });
  });

  it("returns null for a missing memory", async () => {
    await expect(adapter.get("missing-sqlite-memory")).resolves.toBeNull();
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

  it("touches a stored memory", async () => {
    const memory = await adapter.store({ actorId, content: "touch me" });
    await expect(adapter.touch(memory.id)).resolves.toBeUndefined();
    await expect(adapter.get(memory.id)).resolves.toMatchObject({ id: memory.id });
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
