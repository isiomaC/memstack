// Child process for the multi-process e2e test: opens its own connection to
// a server database, initializes the adapter, and writes memories.
import type { StorageProvider } from "../../src/interfaces.js";

const [backend, name, actorId, countArg] = process.argv.slice(2);
const count = Number(countArg);
const PG_PORT = process.env.PG_PORT ?? "5433";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? "6380");

let storage: StorageProvider;
let close: () => Promise<void>;

if (backend === "postgres") {
  const { PostgresStorageAdapter } = await import("../../src/adapters/storage/postgres.js");
  const adapter = new PostgresStorageAdapter({ connectionString: `postgres://memstack:memstack@localhost:${PG_PORT}/memstack`, tableName: name });
  storage = adapter;
  close = () => adapter.close();
} else if (backend === "redis") {
  const { default: Redis } = await import("ioredis");
  const { RedisStorageAdapter } = await import("../../src/adapters/storage/redis.js");
  const redis = new Redis({ host: "localhost", port: REDIS_PORT });
  storage = new RedisStorageAdapter({ redis: redis as never, keyPrefix: name });
  close = async () => void (await redis.quit());
} else if (backend === "mongodb") {
  const { MongoClient } = await import("mongodb");
  const { MongoDBStorageAdapter } = await import("../../src/adapters/storage/mongodb.js");
  const client = new MongoClient("mongodb://localhost:27017");
  await client.connect();
  storage = new MongoDBStorageAdapter({ collection: client.db("memstack_e2e").collection(name) as never });
  close = () => client.close();
} else {
  throw new Error(`Unknown backend ${backend}`);
}

await storage.initialize();
for (let i = 0; i < count; i++) {
  await storage.store({ actorId, content: `${actorId} single write ${i}` });
}
for (let i = 0; i < count; i += 10) {
  await storage.storeBatch(Array.from({ length: 10 }, (_, j) => ({ actorId, content: `${actorId} batch write ${i + j}` })));
}
await storage.retrieve({ actorId, limit: 5 });
await close();
