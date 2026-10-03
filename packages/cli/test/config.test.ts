import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const SAVED_ENV = { ...process.env };

let home: string;

function clearMemstackEnv() {
  // An empty MEMSTACK_HOME, so the developer's own ~/.memstack/config.json can't leak in.
  home = mkdtempSync(join(tmpdir(), "memstack-config-test-"));
  process.env.MEMSTACK_HOME = home;
  delete process.env.MEMSTACK_STORAGE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) delete process.env[key];
  }
  Object.assign(process.env, SAVED_ENV);
}

beforeEach(() => clearMemstackEnv());
afterEach(() => {
  restoreEnv();
  rmSync(home, { recursive: true, force: true });
});

// Full config behavior (storage backends, LLM/embedding selection, how the
// environment overrides the config file) is covered by packages/config-env/test.
// This just confirms the CLI wires @memstack/config-env's loadConfig() through.
describe("loadConfig", () => {
  it("delegates to @memstack/config-env and returns a MemStackConfig", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const config = await loadConfig();
    expect(config.llm).toBeDefined();
    expect(config.storage).toBeDefined();
  });

  it("reads the config file when no variables are set", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, llm: { provider: "anthropic", apiKey: "sk-ant-test" }, storage: { type: "memory" } }), { mode: 0o600 });
    const config = await loadConfig();
    expect(config.llm?.constructor.name).toBe("AnthropicLLMAdapter");
  });

  it("propagates errors from the shared loader", async () => {
    await expect(loadConfig()).rejects.toThrow(
      "At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY must be set",
    );
  });
});
