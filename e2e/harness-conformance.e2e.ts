/**
 * Harness memory conformance against real server backends.
 *
 * Requires: docker compose up -d postgres redis mongodb
 * Env: PG_PORT (default 5433), REDIS_PORT (default 6380)
 */
import { Pool } from "pg";
import Redis from "ioredis";
import { MongoClient } from "mongodb";
import { PostgresStorageAdapter } from "../src/adapters/storage/postgres.js";
import { RedisStorageAdapter } from "../src/adapters/storage/redis.js";
import { MongoDBStorageAdapter } from "../src/adapters/storage/mongodb.js";
import { runHarnessConformance } from "../test/harness/conformance.js";

const PG_PORT = parseInt(process.env.PG_PORT ?? "5433", 10);
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? "6380", 10);

runHarnessConformance("postgres", async () => {
  const pool = new Pool({ connectionString: `postgres://memstack:memstack@localhost:${PG_PORT}/memstack`, max: 5 });
  const storage = new PostgresStorageAdapter({ pool, tableName: "e2e_harness_conformance" });
  return {
    storage,
    teardown: async () => {
      await pool.query("DROP TABLE IF EXISTS e2e_harness_conformance");
      await storage.close();
      await pool.end();
    },
  };
});

runHarnessConformance("redis", async () => {
  const redis = new Redis({ host: "localhost", port: REDIS_PORT, lazyConnect: true });
  await redis.connect();
  const storage = new RedisStorageAdapter({ redis: redis as never, keyPrefix: "e2e_harness" });
  return {
    storage,
    teardown: async () => {
      const keys = await redis.keys("e2e_harness:*");
      if (keys.length > 0) await redis.del(keys);
      await storage.close();
      await redis.quit();
    },
  };
});

runHarnessConformance("mongodb", async () => {
  const client = new MongoClient("mongodb://localhost:27017");
  await client.connect();
  const collName = `e2e_harness_${Date.now().toString(36)}`;
  const storage = new MongoDBStorageAdapter({ collection: client.db("memstack_e2e").collection(collName) as never });
  return {
    storage,
    teardown: async () => {
      await client.db("memstack_e2e").dropCollection(collName).catch(() => undefined);
      await storage.close();
      await client.close();
    },
  };
});
