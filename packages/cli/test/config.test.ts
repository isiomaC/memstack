import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const SAVED_ENV = { ...process.env };

function clearMemstackEnv() {
  delete process.env.MEMSTACK_STORAGE;
  delete process.env.MEMSTACK_DIR;
  delete process.env.DATABASE_URL;
  delete process.env.SQLITE_PATH;
  delete process.env.REDIS_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, SAVED_ENV);
}

beforeEach(() => clearMemstackEnv());
afterEach(() => restoreEnv());

describe("loadConfig", () => {
  it("throws when no API keys are set", async () => {
    await expect(loadConfig()).rejects.toThrow(
      "At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY must be set",
    );
  });

  it("uses InMemoryStorage when MEMSTACK_STORAGE is memory", async () => {
    process.env.MEMSTACK_STORAGE = "memory";
    process.env.OPENAI_API_KEY = "sk-test";
    const config = await loadConfig();
    expect(config.storage).toBeDefined();
  });

  it("uses postgres storage adapter from DATABASE_URL", async () => {
    process.env.MEMSTACK_STORAGE = "postgres";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    process.env.OPENAI_API_KEY = "sk-test";
    const config = await loadConfig();
    expect(config.storage).toBeDefined();
  });

  it("throws for postgres when DATABASE_URL is missing", async () => {
    process.env.MEMSTACK_STORAGE = "postgres";
    process.env.OPENAI_API_KEY = "sk-test";
    await expect(loadConfig()).rejects.toThrow("postgres storage requires DATABASE_URL");
  });

  it("uses markdown storage adapter with custom MEMSTACK_DIR", async () => {
    process.env.MEMSTACK_STORAGE = "markdown";
    process.env.MEMSTACK_DIR = "/tmp/test-memories";
    process.env.OPENAI_API_KEY = "sk-test";
    const config = await loadConfig();
    expect(config.storage).toBeDefined();
  });

  it("uses disk storage adapter from MEMSTACK_DIR", async () => {
    process.env.MEMSTACK_STORAGE = "disk";
    process.env.MEMSTACK_DIR = "/tmp/test-memstack-data";
    process.env.OPENAI_API_KEY = "sk-test";
    const config = await loadConfig();
    expect(config.storage).toBeDefined();
  });

  it("uses Anthropic LLM when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = await loadConfig();
    expect(config.llm).toBeDefined();
  });

  it("uses OpenAI embedding when OPENAI_API_KEY is set", async () => {
    // Anthropic LLM would be picked if ANTHROPIC_API_KEY is also set,
    // but we only want to test embedding. Set OPENAI_API_KEY only.
    process.env.OPENAI_API_KEY = "sk-test";
    const config = await loadConfig();
    expect(config.embedding).toBeDefined();
  });

  it("returns undefined embedding when OPENAI_API_KEY is not set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = await loadConfig();
    expect(config.embedding).toBeUndefined();
  });

  it("throws for unknown MEMSTACK_STORAGE value", async () => {
    process.env.MEMSTACK_STORAGE = "turso";
    process.env.OPENAI_API_KEY = "sk-test";
    await expect(loadConfig()).rejects.toThrow(
      'Unknown MEMSTACK_STORAGE: "turso"',
    );
  });
});
