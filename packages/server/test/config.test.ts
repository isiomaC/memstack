import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const SAVED_ENV = { ...process.env };

function clearMemstackEnv() {
  delete process.env.MEMSTACK_STORAGE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MEMSTACK_EMBED_ON_STORE;
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) delete process.env[key];
  }
  Object.assign(process.env, SAVED_ENV);
}

beforeEach(() => clearMemstackEnv());
afterEach(() => restoreEnv());

// Full env-var behavior (storage backends, LLM/embedding selection, actor ID,
// embedOnStore) is covered by packages/config-env/test — this just confirms
// the server wires @memstack/config-env's loadConfigFromEnv() through correctly.
describe("loadConfig", () => {
  it("delegates to @memstack/config-env and returns a MemStackConfig", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MEMSTACK_EMBED_ON_STORE = "false";
    const config = await loadConfig();
    expect(config.llm).toBeDefined();
    expect(config.defaults?.embedOnStore).toBe(false);
  });

  it("propagates errors from the shared loader", async () => {
    await expect(loadConfig()).rejects.toThrow(
      "At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY must be set",
    );
  });
});
