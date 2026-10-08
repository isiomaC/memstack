import type { MemStackConfig, StorageProvider, LLMProvider, EmbeddingProvider } from "@memstack/core";
import { readConfigFile } from "./config-file.js";
import type { MemStackConfigFile } from "./config-file.js";
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

type Env = Record<string, string | undefined>;

// Drivers are optional peers the user installs; only a missing module means "install it".
function isMissingModule(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/** Stands in when no key is set (harness entry points). Only LLM-dependent calls fail, with a message that says why. */
const NO_LLM: LLMProvider = {
  async complete() {
    throw new Error("No LLM key is configured. Run `memstack init` to add one.");
  },
};

function hasLLMKey(env: Env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
}

function buildLLMAdapter(env: Env): LLMProvider {
  if (!hasLLMKey(env)) {
    throw new Error("At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY must be set");
  }
  if (env.ANTHROPIC_API_KEY) {
    return new AnthropicLLMAdapter({ apiKey: env.ANTHROPIC_API_KEY, defaultModel: env.MEMSTACK_LLM_MODEL });
  }
  return new OpenAILLMAdapter({
    apiKey: env.OPENAI_API_KEY ?? "",
    baseURL: env.MEMSTACK_OPENAI_BASE_URL,
    defaultModel: env.MEMSTACK_LLM_MODEL,
  });
}

function buildEmbeddingAdapter(env: Env): EmbeddingProvider | undefined {
  if (env.MEMSTACK_OPENAI_BASE_URL) return undefined;
  if (env.OPENAI_API_KEY) {
    return new OpenAIEmbeddingAdapter({ apiKey: env.OPENAI_API_KEY });
  }
  return undefined;
}

async function buildStorageAdapter(env: Env): Promise<StorageProvider> {
  const storage = env.MEMSTACK_STORAGE ?? "memory";

  switch (storage) {
    case "memory":
      return new InMemoryStorageAdapter();

    case "markdown":
      return new MarkdownStorageAdapter({
        dir: env.MEMSTACK_DIR ?? "./memories",
      });

    case "disk":
      return new DiskStorageAdapter({
        storageDir: env.MEMSTACK_DIR ?? "./memstack-data",
      });

    case "postgres":
      if (!env.DATABASE_URL) {
        throw new Error("postgres storage requires DATABASE_URL");
      }
      return new PostgresStorageAdapter({
        connectionString: env.DATABASE_URL,
      });

    case "sqlite": {
      try {
        // @ts-expect-error optional peer dep
        const BetterSqlite3 = await import("better-sqlite3");
        const db = new BetterSqlite3.default(
          env.SQLITE_PATH ?? "./memstack.db",
        );
        return new SQLiteStorageAdapter({ db: db as never });
      } catch (error) {
        if (!isMissingModule(error)) throw error;
        throw new Error(
          "SQLite requires better-sqlite3. Install: npm install better-sqlite3@^11.10.0",
        );
      }
    }

    case "redis": {
      try {
        const Redis = await import("ioredis");
        const client = new Redis.default(
          env.REDIS_URL ?? "redis://localhost:6379",
        );
        return new RedisStorageAdapter({ redis: client as never });
      } catch (error) {
        if (!isMissingModule(error)) throw error;
        throw new Error(
          "Redis requires ioredis. Install: npm install ioredis@^5.11.1",
        );
      }
    }

    default:
      throw new Error(`Unknown MEMSTACK_STORAGE: "${storage}". Supported: memory, markdown, disk, postgres, sqlite, redis`);
  }
}

export interface EnvConfigResult {
  config: MemStackConfig;
  /** From MEMSTACK_ACTOR, defaults to "default". Only meaningful for clients that scope work to one actor per process (e.g. the MCP server). */
  defaultActorId: string;
  /** False when no LLM key is set, so `config.llm` is a stand-in that fails if called. Only the file-aware loader allows this. */
  llmConfigured: boolean;
}

/**
 * Builds a MemStackConfig purely from environment variables. Shared by
 * @memstack/cli, @memstack/mcp, and @memstack/server so storage/LLM/embedding
 * wiring and env var behavior can't drift between the three entry points.
 */
export async function loadConfigFromEnv(): Promise<EnvConfigResult> {
  return buildConfig(process.env, { llmOptional: false });
}

/**
 * Builds a MemStackConfig from `~/.memstack/config.json` overlaid with
 * environment variables. Used by harness entry points. Each section is taken
 * whole from one source: any LLM variable in the environment replaces the
 * file's `llm` section, and `MEMSTACK_STORAGE` replaces its `storage`
 * section, so a key from one provider is never sent to another's URL. The key
 * is optional here: without one, `llmConfigured` is false and memories are
 * saved without topic tags.
 */
export async function loadConfig(options: { configPath?: string } = {}): Promise<EnvConfigResult> {
  return buildConfig(mergeConfigFile(readConfigFile(options.configPath), process.env), { llmOptional: true });
}

/** The environment with the config file's sections filled in where the environment has none. */
export function mergeConfigFile(file: MemStackConfigFile | undefined, env: Env): Env {
  const merged: Env = { ...env };
  const envHasLLM = LLM_ENV.some((key) => env[key] !== undefined);
  if (file?.llm && !envHasLLM) {
    if (file.llm.provider === "anthropic") merged.ANTHROPIC_API_KEY = file.llm.apiKey;
    else {
      merged.OPENAI_API_KEY = file.llm.apiKey;
      merged.MEMSTACK_OPENAI_BASE_URL = file.llm.baseURL;
    }
    merged.MEMSTACK_LLM_MODEL = file.llm.model;
  }
  if (file?.storage && env.MEMSTACK_STORAGE === undefined) {
    const { type, path, url } = file.storage;
    merged.MEMSTACK_STORAGE = type;
    if (type === "sqlite") merged.SQLITE_PATH = path;
    if (type === "disk" || type === "markdown") merged.MEMSTACK_DIR = path;
    if (type === "postgres") merged.DATABASE_URL = url;
    if (type === "redis") merged.REDIS_URL = url;
  }
  return merged;
}

const LLM_ENV = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MEMSTACK_OPENAI_BASE_URL", "MEMSTACK_LLM_MODEL"];

async function buildConfig(env: Env, { llmOptional }: { llmOptional: boolean }): Promise<EnvConfigResult> {
  const llmConfigured = hasLLMKey(env);
  const llm = llmOptional && !llmConfigured ? NO_LLM : buildLLMAdapter(env);
  const embedding = buildEmbeddingAdapter(env);
  const storage = await buildStorageAdapter(env);
  const embedOnStore = env.MEMSTACK_EMBED_ON_STORE !== "false";
  const defaultActorId = env.MEMSTACK_ACTOR ?? "default";

  return {
    config: { llm, embedding, storage, defaults: { embedOnStore } },
    defaultActorId,
    llmConfigured,
  };
}

export { resolveProject, normalizeRemote, pinProject, PIN_FILE } from "./project.js";
export type { ProjectIdentity, ProjectSource } from "./project.js";
export {
  STORAGE_TYPES,
  memstackHome,
  configFilePath,
  readConfigFile,
  writeConfigFile,
  checkConfigPermissions,
} from "./config-file.js";
export type { MemStackConfigFile, StorageType } from "./config-file.js";
