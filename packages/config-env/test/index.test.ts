import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfigFromEnv } from "../src/index.js";

const SAVED_ENV = { ...process.env };

function clearMemstackEnv() {
  delete process.env.MEMSTACK_STORAGE;
  delete process.env.MEMSTACK_DIR;
  delete process.env.DATABASE_URL;
  delete process.env.SQLITE_PATH;
  delete process.env.REDIS_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MEMSTACK_OPENAI_BASE_URL;
  delete process.env.MEMSTACK_LLM_MODEL;
  delete process.env.MEMSTACK_EMBED_ON_STORE;
  delete process.env.MEMSTACK_ACTOR;
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

describe("loadConfigFromEnv", () => {
  it("returns defaults when no env vars are set beyond an API key", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { config } = await loadConfigFromEnv();
    expect(config.llm).toBeDefined();
    expect(config.storage).toBeDefined();
    expect(config.embedding).toBeDefined();
  });

  it("throws when no API key is set", async () => {
    await expect(loadConfigFromEnv()).rejects.toThrow(
      "At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY must be set",
    );
  });

  it("uses default actor ID when MEMSTACK_ACTOR is not set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { defaultActorId } = await loadConfigFromEnv();
    expect(defaultActorId).toBe("default");
  });

  it("uses MEMSTACK_ACTOR env var as defaultActorId", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MEMSTACK_ACTOR = "my-agent";
    const { defaultActorId } = await loadConfigFromEnv();
    expect(defaultActorId).toBe("my-agent");
  });

  it("defaults embedOnStore to true", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { config } = await loadConfigFromEnv();
    expect(config.defaults?.embedOnStore).toBe(true);
  });

  it("disables embedOnStore when MEMSTACK_EMBED_ON_STORE=false", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MEMSTACK_EMBED_ON_STORE = "false";
    const { config } = await loadConfigFromEnv();
    expect(config.defaults?.embedOnStore).toBe(false);
  });

  it("throws for unknown MEMSTACK_STORAGE value", async () => {
    process.env.MEMSTACK_STORAGE = "unknown-backend";
    process.env.OPENAI_API_KEY = "sk-test";
    await expect(loadConfigFromEnv()).rejects.toThrow(/Unknown MEMSTACK_STORAGE/);
  });

  it("uses InMemoryStorage when MEMSTACK_STORAGE is memory", async () => {
    process.env.MEMSTACK_STORAGE = "memory";
    process.env.OPENAI_API_KEY = "sk-test";
    const { config } = await loadConfigFromEnv();
    expect(config.storage).toBeDefined();
  });

  it("uses postgres storage adapter from DATABASE_URL", async () => {
    process.env.MEMSTACK_STORAGE = "postgres";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    process.env.OPENAI_API_KEY = "sk-test";
    const { config } = await loadConfigFromEnv();
    expect(config.storage).toBeDefined();
  });

  it("throws for postgres when DATABASE_URL is missing", async () => {
    process.env.MEMSTACK_STORAGE = "postgres";
    process.env.OPENAI_API_KEY = "sk-test";
    await expect(loadConfigFromEnv()).rejects.toThrow("postgres storage requires DATABASE_URL");
  });

  it("uses markdown storage adapter with custom MEMSTACK_DIR", async () => {
    process.env.MEMSTACK_STORAGE = "markdown";
    process.env.MEMSTACK_DIR = "/tmp/test-memories";
    process.env.OPENAI_API_KEY = "sk-test";
    const { config } = await loadConfigFromEnv();
    expect(config.storage).toBeDefined();
  });

  it("uses disk storage adapter from MEMSTACK_DIR", async () => {
    process.env.MEMSTACK_STORAGE = "disk";
    process.env.MEMSTACK_DIR = "/tmp/test-memstack-data";
    process.env.OPENAI_API_KEY = "sk-test";
    const { config } = await loadConfigFromEnv();
    expect(config.storage).toBeDefined();
  });

  it("uses Anthropic LLM when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { config } = await loadConfigFromEnv();
    expect(config.llm).toBeDefined();
  });

  it("prefers Anthropic over OpenAI when both keys are set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const { config } = await loadConfigFromEnv();
    expect(config.llm).toBeDefined();
    expect(config.embedding).toBeDefined();
  });

  it("uses OpenAI embedding when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { config } = await loadConfigFromEnv();
    expect(config.embedding).toBeDefined();
  });

  it("returns undefined embedding when OPENAI_API_KEY is not set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { config } = await loadConfigFromEnv();
    expect(config.embedding).toBeUndefined();
  });

  it("returns undefined embedding when MEMSTACK_OPENAI_BASE_URL overrides the LLM endpoint", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MEMSTACK_OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    const { config } = await loadConfigFromEnv();
    expect(config.embedding).toBeUndefined();
  });
});
