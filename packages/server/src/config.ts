import type { MemStackConfig, StorageProvider, LLMProvider, EmbeddingProvider } from "@memstack/core";
import {
  InMemoryStorageAdapter,
  DiskStorageAdapter,
  MarkdownStorageAdapter,
  PostgresStorageAdapter,
  SQLiteStorageAdapter,
  RedisStorageAdapter,
  OpenAILLMAdapter,
  AnthropicLLMAdapter,
  OpenAIEmbeddingAdapter,
} from "@memstack/core";

function buildLLMAdapter(): LLMProvider {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error("At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY must be set");
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicLLMAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return new OpenAILLMAdapter({ apiKey: process.env.OPENAI_API_KEY ?? "", baseURL: process.env.MEMSTACK_OPENAI_BASE_URL, defaultModel: process.env.MEMSTACK_LLM_MODEL });
}

function buildEmbeddingAdapter(): EmbeddingProvider | undefined {
  if (process.env.MEMSTACK_OPENAI_BASE_URL) return undefined;
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIEmbeddingAdapter({ apiKey: process.env.OPENAI_API_KEY });
  }
  return undefined;
}

async function buildStorageAdapter(): Promise<StorageProvider> {
  const storage = process.env.MEMSTACK_STORAGE ?? "memory";

  switch (storage) {
    case "memory":
      return new InMemoryStorageAdapter();

    case "markdown":
      return new MarkdownStorageAdapter({
        dir: process.env.MEMSTACK_DIR ?? "./memories",
      });

    case "disk":
      return new DiskStorageAdapter({
        storageDir: process.env.MEMSTACK_DIR ?? "./memstack-data",
      });

    case "postgres":
      if (!process.env.DATABASE_URL) {
        throw new Error("postgres storage requires DATABASE_URL");
      }
      return new PostgresStorageAdapter({
        connectionString: process.env.DATABASE_URL,
      });

    case "sqlite": {
      try {
        // @ts-expect-error optional peer dep
        const BetterSqlite3 = await import("better-sqlite3");
        const db = new BetterSqlite3.default(
          process.env.SQLITE_PATH ?? "./memstack.db",
        );
        return new SQLiteStorageAdapter({ db: db as never });
      } catch {
        throw new Error(
          "SQLite requires better-sqlite3. Install: npm install better-sqlite3",
        );
      }
    }

    case "redis": {
      try {
        const Redis = await import("ioredis");
        const client = new Redis.default(
          process.env.REDIS_URL ?? "redis://localhost:6379",
        );
        return new RedisStorageAdapter({ redis: client as never });
      } catch {
        throw new Error(
          "Redis requires ioredis. Install: npm install ioredis",
        );
      }
    }

    default:
      throw new Error(`Unknown MEMSTACK_STORAGE: "${storage}". Supported: memory, markdown, disk, postgres, sqlite, redis`);
  }
}

export async function loadConfig(): Promise<MemStackConfig> {
  const llm = buildLLMAdapter();
  const embedding = buildEmbeddingAdapter();
  const storage = await buildStorageAdapter();

  return { llm, embedding, storage };
}
