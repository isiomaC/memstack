/**
 * Two processes initialize and write the same store at once, as Claude Code
 * and Codex do. Verifies the `multiProcess` capability that the Postgres,
 * Redis, and MongoDB adapters declare.
 *
 * Requires: docker compose up -d postgres redis mongodb
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import Redis from "ioredis";
import { MongoClient } from "mongodb";
import { PostgresStorageAdapter } from "../src/adapters/storage/postgres.js";
import { RedisStorageAdapter } from "../src/adapters/storage/redis.js";
import { MongoDBStorageAdapter } from "../src/adapters/storage/mongodb.js";
import type { StorageProvider } from "../src/interfaces.js";

const PG_PORT = parseInt(process.env.PG_PORT ?? "5433", 10);
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? "6380", 10);
const writer = fileURLToPath(new URL("./fixtures/server-writer.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const PER_PROCESS = 200;
const suffix = Date.now().toString(36);

function runWriter(backend: string, name: string, actorId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, writer, backend, name, actorId, String(PER_PROCESS)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${backend} writer ${actorId} exited ${code}: ${stderr}`))));
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
});

const backends: [string, string, () => Promise<{ storage: StorageProvider; cleanup: () => Promise<void> }>][] = [
  [
    "postgres",
    `e2e_multi_${suffix}`,
    async () => {
      const pool = new Pool({ connectionString: `postgres://memstack:memstack@localhost:${PG_PORT}/memstack` });
      const table = `e2e_multi_${suffix}`;
      return {
        storage: new PostgresStorageAdapter({ pool, tableName: table }),
        cleanup: async () => {
          await pool.query(`DROP TABLE IF EXISTS ${table}`);
          await pool.end();
        },
      };
    },
  ],
  [
    "redis",
    `e2e_multi_${suffix}`,
    async () => {
      const redis = new Redis({ host: "localhost", port: REDIS_PORT });
      return {
        storage: new RedisStorageAdapter({ redis: redis as never, keyPrefix: `e2e_multi_${suffix}` }),
        cleanup: async () => {
          const keys = await redis.keys(`e2e_multi_${suffix}:*`);
          if (keys.length > 0) await redis.del(keys);
          await redis.quit();
        },
      };
    },
  ],
  [
    "mongodb",
    `e2e_multi_${suffix}`,
    async () => {
      const client = new MongoClient("mongodb://localhost:27017");
      await client.connect();
      const collection = client.db("memstack_e2e").collection(`e2e_multi_${suffix}`);
      return {
        storage: new MongoDBStorageAdapter({ collection: collection as never }),
        cleanup: async () => {
          await collection.drop().catch(() => undefined);
          await client.close();
        },
      };
    },
  ],
];

describe.each(backends)("multi-process writes: %s", (backend, name, open) => {
  it("two processes initialize and write the same store without errors or lost writes", async () => {
    await Promise.all([runWriter(backend, name, "claude-code"), runWriter(backend, name, "codex")]);

    const { storage, cleanup } = await open();
    cleanups.push(cleanup);
    expect(storage.capabilities?.multiProcess).toBe(true);
    expect(await storage.count({ actorId: "claude-code" })).toBe(PER_PROCESS * 2);
    expect(await storage.count({ actorId: "codex" })).toBe(PER_PROCESS * 2);
    expect(await storage.count()).toBe(PER_PROCESS * 4);
  }, 120_000);
});
