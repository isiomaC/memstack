// ~/.memstack/config.json. Holds the LLM provider and key and
// the storage choice, so harness MCP configs carry no secrets. The file never
// makes MemStack install a storage driver; it only records which one to load.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STORAGE_TYPES = ["memory", "markdown", "disk", "postgres", "sqlite", "redis"] as const;
export type StorageType = (typeof STORAGE_TYPES)[number];

export interface MemStackConfigFile {
  version: 1;
  llm?: {
    provider: "openai-compatible" | "anthropic";
    apiKey: string;
    baseURL?: string;
    model?: string;
  };
  storage?: {
    type: StorageType;
    /** File path for sqlite, directory for disk and markdown. */
    path?: string;
    /** Connection URL for postgres and redis. */
    url?: string;
  };
}

/** `$MEMSTACK_HOME`, or `~/.memstack`. */
export function memstackHome(): string {
  return process.env.MEMSTACK_HOME ?? join(homedir(), ".memstack");
}

export function configFilePath(home: string = memstackHome()): string {
  return join(home, "config.json");
}

/** The parsed config file, or undefined when it does not exist. Throws on invalid content. */
export function readConfigFile(path: string = configFilePath()): MemStackConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return validateConfigFile(parsed, path);
}

/**
 * Writes the config file atomically, creating the directory with mode 0700
 * and the file with mode 0600, and tightening modes of existing ones.
 */
export function writeConfigFile(config: MemStackConfigFile, path: string = configFilePath()): void {
  validateConfigFile(config, path);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Warnings about the config file's permissions; empty when they are owner-only or the file is absent. */
export function checkConfigPermissions(path: string = configFilePath()): string[] {
  if (process.platform === "win32" || !existsSync(path)) return [];
  const warnings: string[] = [];
  const fileMode = statSync(path).mode & 0o777;
  if (fileMode & 0o077) {
    warnings.push(`${path} is readable by other users (mode ${fileMode.toString(8)}). Run: chmod 600 ${path}`);
  }
  const dir = join(path, "..");
  const dirMode = statSync(dir).mode & 0o777;
  if (dirMode & 0o077) {
    warnings.push(`${dir} is accessible by other users (mode ${dirMode.toString(8)}). Run: chmod 700 ${dir}`);
  }
  return warnings;
}

function validateConfigFile(value: unknown, path: string): MemStackConfigFile {
  const fail = (message: string): never => {
    throw new Error(`Invalid ${path}: ${message}`);
  };
  if (!isObject(value)) fail("expected a JSON object");
  const config = value as Record<string, unknown>;
  if (config.version !== 1) fail(`unsupported version ${JSON.stringify(config.version)}, expected 1`);

  if (config.llm !== undefined) {
    if (!isObject(config.llm)) fail("llm must be an object");
    const llm = config.llm as Record<string, unknown>;
    if (llm.provider !== "openai-compatible" && llm.provider !== "anthropic") {
      fail('llm.provider must be "openai-compatible" or "anthropic"');
    }
    if (typeof llm.apiKey !== "string" || !llm.apiKey) fail("llm.apiKey must be a non-empty string");
    for (const key of ["baseURL", "model"]) {
      if (llm[key] !== undefined && typeof llm[key] !== "string") fail(`llm.${key} must be a string`);
    }
  }

  if (config.storage !== undefined) {
    if (!isObject(config.storage)) fail("storage must be an object");
    const storage = config.storage as Record<string, unknown>;
    if (!STORAGE_TYPES.includes(storage.type as StorageType)) {
      fail(`storage.type must be one of ${STORAGE_TYPES.join(", ")}`);
    }
    for (const key of ["path", "url"]) {
      if (storage[key] !== undefined && typeof storage[key] !== "string") fail(`storage.${key} must be a string`);
    }
  }

  return config as unknown as MemStackConfigFile;
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
