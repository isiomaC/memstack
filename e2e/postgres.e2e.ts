/**
 * End-to-end tests for PostgresStorageAdapter against a real PostgreSQL instance.
 *
 * Requires: docker compose up -d postgres
 * Env: PG_PORT (default 5433)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { PostgresStorageAdapter } from "../src/adapters/storage/postgres.js";

const PG_PORT = parseInt(process.env.PG_PORT ?? "5433", 10);
const CONN_STR = `postgres://memstack:memstack@localhost:${PG_PORT}/memstack`;

describe("PostgresStorageAdapter E2E", () => {
  let pool: Pool;
  let adapter: PostgresStorageAdapter;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONN_STR, max: 5 });
    adapter = new PostgresStorageAdapter({ pool, tableName: "e2e_postgres" });
    await adapter.initialize();
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS e2e_postgres");
    await adapter.close();
    await pool.end();
  });

  it("1. pool injection — store, get, retrieve work", async () => {
    const mem = await adapter.store({
      actorId: "pg-e2e-actor",
      content: "Pool injection test",
      importance: 0.9,
    });
    expect(mem.id).toMatch(/^mem_/);
    expect(mem.actorId).toBe("pg-e2e-actor");

    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Pool injection test");
    expect(retrieved!.importance).toBe(0.9);

    const results = await adapter.retrieve({
      actorId: "pg-e2e-actor",
      strategy: "important",
      limit: 5,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toBe("Pool injection test");
  });

  it("2. connectionString — create a second adapter via connectionString, verify it works", async () => {
    const connStrAdapter = new PostgresStorageAdapter({
      connectionString: CONN_STR,
      tableName: "e2e_postgres_cs",
    });
    await connStrAdapter.initialize();

    const mem = await connStrAdapter.store({
      actorId: "pg-cs-actor",
      content: "Connection string test",
    });
    const retrieved = await connStrAdapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Connection string test");

    const count = await connStrAdapter.count({ actorId: "pg-cs-actor" });
    expect(count).toBe(1);

    // Clean up
    const pool2 = new Pool({ connectionString: CONN_STR });
    await pool2.query("DROP TABLE IF EXISTS e2e_postgres_cs");
    await connStrAdapter.close();
    await pool2.end();
  });

  it("3. batch store — storeBatch 3 memories, verify count=3", async () => {
    const results = await adapter.storeBatch([
      { actorId: "pg-batch", content: "batch-1" },
      { actorId: "pg-batch", content: "batch-2" },
      { actorId: "pg-batch", content: "batch-3" },
    ]);
    expect(results).toHaveLength(3);
    const count = await adapter.count({ actorId: "pg-batch" });
    expect(count).toBe(3);
  });

  it("4. touch — store memory, touch it, verify get still returns it", async () => {
    const mem = await adapter.store({
      actorId: "pg-touch",
      content: "Touch me",
    });
    await adapter.touch(mem.id);
    const retrieved = await adapter.get(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(mem.id);
  });

  it("5. semantic search — store 3 memories with embeddings, retrieve with semantic strategy", async () => {
    const actorId = "pg-semantic";
    const embA = Array(1536).fill(0);
    embA[0] = 0.9; embA[1] = 0.1;
    const embB = Array(1536).fill(0);
    embB[0] = 0.1; embB[1] = 0.9;
    const embC = Array(1536).fill(0);
    embC[2] = 0.9;

    await adapter.store({
      actorId,
      content: "goblin attack",
      embedding: embA,
    });
    await adapter.store({
      actorId,
      content: "dragon sighting",
      embedding: embB,
    });
    await adapter.store({
      actorId,
      content: "peaceful meadow",
      embedding: embC,
    });

    const queryVec = Array(1536).fill(0);
    queryVec[0] = 0.85; queryVec[1] = 0.15;

    const results = await adapter.retrieve(
      { actorId, strategy: "semantic", limit: 2 },
      queryVec
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content === "goblin attack")).toBe(true);
  });

  it("6. importance sort — store 3 memories with different importance, retrieve with important strategy", async () => {
    const actorId = "pg-importance";
    await adapter.store({ actorId, content: "low", importance: 0.1 });
    await adapter.store({ actorId, content: "medium", importance: 0.5 });
    await adapter.store({ actorId, content: "high", importance: 0.9 });

    const results = await adapter.retrieve({
      actorId,
      strategy: "important",
      limit: 3,
    });
    expect(results).toHaveLength(3);
    expect(results[0].content).toBe("high");
    expect(results[2].content).toBe("low");
  });

  it("7. recent sort — store 3 memories, retrieve with recent strategy", async () => {
    const actorId = "pg-recent";
    const m1 = await adapter.store({ actorId, content: "first" });
    await new Promise((r) => setTimeout(r, 50));
    const m2 = await adapter.store({ actorId, content: "second" });

    const results = await adapter.retrieve({
      actorId,
      strategy: "recent",
      limit: 2,
    });
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("second");
  });

  it("8. tag filter — store memory with tag critical, retrieve with tags filter", async () => {
    const actorId = "pg-tags";
    await adapter.store({ actorId, content: "critical bug", tags: ["critical"] });
    await adapter.store({ actorId, content: "minor issue", tags: ["minor"] });

    const results = await adapter.retrieve({
      actorId,
      tags: ["critical"],
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("critical bug");
  });

  it("9. memoryType filter — store interaction + observation, retrieve only observation", async () => {
    const actorId = "pg-mtype";
    await adapter.store({
      actorId,
      content: "interaction event",
      memoryType: "interaction",
    });
    await adapter.store({
      actorId,
      content: "observed event",
      memoryType: "observation",
    });

    const results = await adapter.retrieve({
      actorId,
      memoryTypes: ["observation"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("observed event");
  });

  it("10. deleteMany — store 3 memories, deleteMany 2, verify count=1", async () => {
    const actorId = "pg-deletemany";
    const m1 = await adapter.store({ actorId, content: "del-1" });
    const m2 = await adapter.store({ actorId, content: "del-2" });
    const m3 = await adapter.store({ actorId, content: "del-3" });

    const deleted = await adapter.deleteMany([m1.id, m2.id]);
    expect(deleted).toBe(2);
    const count = await adapter.count({ actorId });
    expect(count).toBe(1);
    const remaining = await adapter.get(m3.id);
    expect(remaining).not.toBeNull();
    expect(remaining!.content).toBe("del-3");
  });

  it("11. expired memory — store with expiresAt in past, verify get returns null, count excludes it", async () => {
    const past = new Date(Date.now() - 60_000);
    const mem = await adapter.store({
      actorId: "pg-expired",
      content: "expired content",
      expiresAt: past,
    });
    const retrieved = await adapter.get(mem.id);
    expect(retrieved).toBeNull();

    const count = await adapter.count({ actorId: "pg-expired" });
    expect(count).toBe(0);
  });

  it("12. upsert via store — store with same id twice, verify only one record", async () => {
    const id = `mem_pg_upsert_${Date.now()}`;
    const m1 = await adapter.store({
      id,
      actorId: "pg-upsert",
      content: "original",
    });
    expect(m1.content).toBe("original");

    const m2 = await adapter.store({
      id,
      actorId: "pg-upsert",
      content: "updated",
      importance: 0.8,
    });
    expect(m2.id).toBe(id);
    expect(m2.content).toBe("updated");

    const count = await adapter.count({ actorId: "pg-upsert" });
    expect(count).toBe(1);

    const retrieved = await adapter.get(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("updated");
    expect(retrieved!.importance).toBe(0.8);
  });

  it("13. initialize migration — verify initialize() creates table and indexes", async () => {
    const freshPool = new Pool({ connectionString: CONN_STR, max: 2 });
    const freshAdapter = new PostgresStorageAdapter({
      pool: freshPool,
      tableName: "e2e_pg_migration",
    });
    await freshAdapter.initialize();

    const mem = await freshAdapter.store({
      actorId: "pg-migrate",
      content: "migration test",
    });
    expect(mem.id).toMatch(/^mem_/);

    const retrieved = await freshAdapter.get(mem.id);
    expect(retrieved).not.toBeNull();

    // Clean up
    await freshPool.query("DROP TABLE IF EXISTS e2e_pg_migration");
    await freshAdapter.close();
    await freshPool.end();
  });

  it("14. count with filters — actorId, memoryType, minImportance", async () => {
    const actorId = "pg-count";
    await adapter.store({
      actorId,
      content: "interaction-a",
      memoryType: "interaction",
      importance: 0.3,
    });
    await adapter.store({
      actorId,
      content: "observation-a",
      memoryType: "observation",
      importance: 0.7,
    });
    await adapter.store({
      actorId: "pg-count-other",
      content: "other interaction",
      memoryType: "interaction",
      importance: 0.5,
    });

    expect(await adapter.count({ actorId })).toBe(2);
    expect(await adapter.count({ actorId, memoryType: "observation" })).toBe(1);
    expect(await adapter.count({ actorId, minImportance: 0.5 })).toBe(1);
    expect(await adapter.count({ actorId, memoryType: "interaction", minImportance: 0.1 })).toBe(1);
  });
});
