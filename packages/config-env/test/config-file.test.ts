import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkConfigPermissions,
  readConfigFile,
  writeConfigFile,
  type MemStackConfigFile,
} from "../src/config-file.js";
import { mergeConfigFile } from "../src/index.js";

const deepseek: MemStackConfigFile = {
  version: 1,
  llm: { provider: "openai-compatible", apiKey: "sk-file", baseURL: "https://api.deepseek.com", model: "deepseek-flash" },
  storage: { type: "sqlite", path: "/home/me/.memstack/memstack.db" },
};

describe("config file", () => {
  let home: string;
  let path: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "memstack-home-"));
    path = join(home, "nested", "config.json");
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("round-trips through an owner-only file and directory", () => {
    writeConfigFile(deepseek, path);
    expect(readConfigFile(path)).toEqual(deepseek);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "nested")).mode & 0o777).toBe(0o700);
    }
    expect(checkConfigPermissions(path)).toEqual([]);
  });

  it("returns undefined when there is no file", () => {
    expect(readConfigFile(path)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("warns about permissions broader than owner-only", () => {
    writeConfigFile(deepseek, path);
    chmodSync(path, 0o644);
    const warnings = checkConfigPermissions(path);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/chmod 600/);
    expect(warnings.join()).not.toContain("sk-file");
  });

  it("tightens an existing file's permissions on write", () => {
    writeConfigFile(deepseek, path);
    chmodSync(path, 0o644);
    writeConfigFile(deepseek, path);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["not json", /not valid JSON/],
    ["[]", /JSON object/],
    ['{"version": 2}', /unsupported version/],
    ['{"version": 1, "llm": {"provider": "gemini", "apiKey": "k"}}', /llm.provider/],
    ['{"version": 1, "llm": {"provider": "anthropic", "apiKey": ""}}', /llm.apiKey/],
    ['{"version": 1, "storage": {"type": "dynamo"}}', /storage.type/],
  ])("rejects %s", (content, message) => {
    writeConfigFile({ version: 1 }, path);
    writeFileSync(path, content);
    expect(() => readConfigFile(path)).toThrow(message);
  });

  it("does not leave a temporary file behind", () => {
    writeConfigFile(deepseek, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(deepseek);
    expect(() => statSync(`${path}.${process.pid}.tmp`)).toThrow();
  });
});

describe("mergeConfigFile", () => {
  it("fills LLM and storage settings from the file", () => {
    expect(mergeConfigFile(deepseek, {})).toMatchObject({
      OPENAI_API_KEY: "sk-file",
      MEMSTACK_OPENAI_BASE_URL: "https://api.deepseek.com",
      MEMSTACK_LLM_MODEL: "deepseek-flash",
      MEMSTACK_STORAGE: "sqlite",
      SQLITE_PATH: "/home/me/.memstack/memstack.db",
    });
  });

  it("never pairs an environment key with the file's provider URL", () => {
    const env = mergeConfigFile(deepseek, { OPENAI_API_KEY: "sk-real-openai" });
    expect(env.OPENAI_API_KEY).toBe("sk-real-openai");
    expect(env.MEMSTACK_OPENAI_BASE_URL).toBeUndefined();
    expect(env.MEMSTACK_LLM_MODEL).toBeUndefined();
  });

  it("uses the environment's storage section whole when MEMSTACK_STORAGE is set", () => {
    const env = mergeConfigFile(deepseek, { MEMSTACK_STORAGE: "postgres", DATABASE_URL: "postgres://x" });
    expect(env).toMatchObject({ MEMSTACK_STORAGE: "postgres", DATABASE_URL: "postgres://x" });
    expect(env.SQLITE_PATH).toBeUndefined();
  });

  it("maps each storage type to its variable", () => {
    const withStorage = (storage: MemStackConfigFile["storage"]) => mergeConfigFile({ version: 1, storage }, {});
    expect(withStorage({ type: "postgres", url: "postgres://db" }).DATABASE_URL).toBe("postgres://db");
    expect(withStorage({ type: "redis", url: "redis://r" }).REDIS_URL).toBe("redis://r");
    expect(withStorage({ type: "disk", path: "/data" }).MEMSTACK_DIR).toBe("/data");
  });

  it("maps an anthropic provider to ANTHROPIC_API_KEY", () => {
    const env = mergeConfigFile({ version: 1, llm: { provider: "anthropic", apiKey: "ak" } }, {});
    expect(env.ANTHROPIC_API_KEY).toBe("ak");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
