// Harness commands: init, connect, disconnect, status, doctor, memories
// (ADR 0001). None of them installs packages: when the MCP server or a
// storage driver is missing they print the command for the user to run.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AnthropicLLMAdapter,
  HarnessMemory,
  OpenAILLMAdapter,
  defaultRecallNamespaces,
  projectNamespace,
} from "@memstack/core";
import type { LLMProvider } from "@memstack/core";
import {
  STORAGE_TYPES,
  checkConfigPermissions,
  configFilePath,
  loadConfig,
  memstackHome,
  mergeConfigFile,
  PIN_FILE,
  pinProject,
  readConfigFile,
  resolveProject,
  writeConfigFile,
  type MemStackConfigFile,
  type StorageType,
} from "@memstack/config-env";
import {
  HARNESS_IDS,
  STORAGE_DRIVERS,
  canResolveFrom,
  connectHarness,
  describeStep,
  disconnectHarness,
  findMemstackMcp,
  harnessAdapter,
  harnessLaunch,
  installCommand,
  sameLaunch,
  verifyServer,
} from "./harness/index.js";
import { readBlock, renderBlock } from "./harness/instructions.js";
import { readHook, sessionStartHook } from "./harness/hooks.js";

export const HARNESS_COMMANDS = ["init", "connect", "disconnect", "status", "doctor", "memories", "project"] as const;

export interface HarnessFlags {
  provider?: string;
  "base-url"?: string;
  model?: string;
  "api-key-env"?: string;
  store?: string;
  path?: string;
  url?: string;
  yes?: boolean;
  "dry-run"?: boolean;
  live?: boolean;
  global?: boolean;
  limit?: string;
  delete?: string;
  "no-agents-md"?: boolean;
  "no-hooks"?: boolean;
}

const out = (line = "") => process.stdout.write(`${line}\n`);

export async function runHarnessCommand(command: string, args: string[], flags: HarnessFlags): Promise<number> {
  switch (command) {
    case "init":
      return init(flags);
    case "connect":
      return connect(args, flags);
    case "disconnect":
      return disconnect(args, flags);
    case "status":
      return status();
    case "doctor":
      return doctor(flags);
    case "memories":
      return memories(args, flags);
    case "project":
      return projectCommand(args);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ── init ──

async function init(flags: HarnessFlags): Promise<number> {
  const existing = readConfigFile();
  const interactive = process.stdin.isTTY && !flags.yes;
  const prompt = interactive ? createPrompter() : undefined;

  try {
    const provider = (flags.provider ?? (await prompt?.choose("LLM provider", ["openai-compatible", "anthropic"], existing?.llm?.provider ?? "openai-compatible")) ?? existing?.llm?.provider ?? "openai-compatible") as "openai-compatible" | "anthropic";
    if (provider !== "openai-compatible" && provider !== "anthropic") throw new Error('--provider must be "openai-compatible" or "anthropic"');

    const sameProvider = existing?.llm?.provider === provider;
    let baseURL: string | undefined;
    if (provider === "openai-compatible") {
      baseURL = flags["base-url"] ?? (await prompt?.ask("Base URL (empty for OpenAI)", sameProvider ? existing?.llm?.baseURL ?? "" : "")) ?? (sameProvider ? existing?.llm?.baseURL : undefined);
      baseURL = baseURL || undefined;
    }
    const model = flags.model ?? (await prompt?.ask("Model (empty for the provider default)", sameProvider ? existing?.llm?.model ?? "" : "")) ?? (sameProvider ? existing?.llm?.model : undefined);

    let apiKey: string | undefined;
    if (flags["api-key-env"]) {
      apiKey = process.env[flags["api-key-env"]];
      if (!apiKey) throw new Error(`Environment variable ${flags["api-key-env"]} is empty.`);
    } else if (prompt) {
      apiKey = (await prompt.secret(sameProvider && existing?.llm?.apiKey ? "API key (empty to keep the current one)" : "API key")) || (sameProvider ? existing?.llm?.apiKey : undefined);
    } else if (sameProvider) {
      apiKey = existing?.llm?.apiKey;
    }
    if (!apiKey) throw new Error("An API key is required. Pass --api-key-env <VAR> to read it from an environment variable.");

    const store = (flags.store ?? (await prompt?.choose("Storage", [...STORAGE_TYPES], existing?.storage?.type ?? "sqlite")) ?? existing?.storage?.type ?? "sqlite") as StorageType;
    if (!STORAGE_TYPES.includes(store)) throw new Error(`--store must be one of ${STORAGE_TYPES.join(", ")}`);
    const storage = await storageSettings(store, flags, existing, prompt);

    const llm = { provider, apiKey, ...(baseURL ? { baseURL } : {}), ...(model ? { model } : {}) };
    out("Checking the LLM provider with a test request...");
    await checkLLM(buildLLM(llm));
    out("  ✓ The provider answered.");

    const config: MemStackConfigFile = { version: 1, llm, storage };
    if (storage.type === "sqlite" && storage.path) mkdirSync(join(storage.path, ".."), { recursive: true, mode: 0o700 });
    writeConfigFile(config);
    out(`Saved ${configFilePath()} (readable only by you).`);

    const mcp = findMemstackMcp();
    const driver = STORAGE_DRIVERS[store];
    out();
    if (!mcp || (driver && !canResolveFrom(mcp, driver.module))) {
      out("Next, install the MCP server and your storage driver (MemStack does not install them for you):");
      out(`  ${installCommand(store)}`);
    }
    out("Then connect your agents:");
    out("  memstack connect claude-code");
    out("  memstack connect codex");
    return 0;
  } finally {
    prompt?.close();
  }
}

async function storageSettings(
  type: StorageType,
  flags: HarnessFlags,
  existing: MemStackConfigFile | undefined,
  prompt: Prompter | undefined,
): Promise<NonNullable<MemStackConfigFile["storage"]>> {
  const previous = existing?.storage?.type === type ? existing.storage : undefined;
  switch (type) {
    case "sqlite":
    case "disk":
    case "markdown": {
      const fallback = previous?.path ?? join(memstackHome(), type === "sqlite" ? "memstack.db" : type === "disk" ? "data" : "memories");
      const path = flags.path ?? (await prompt?.ask(type === "sqlite" ? "Database file" : "Directory", fallback)) ?? fallback;
      return { type, path };
    }
    case "postgres":
    case "redis": {
      const url = flags.url ?? (await prompt?.ask(`${type === "postgres" ? "Postgres" : "Redis"} connection URL`, previous?.url ?? "")) ?? previous?.url;
      if (!url) throw new Error(`--url is required for ${type}.`);
      return { type, url };
    }
    case "memory":
      return { type };
  }
}

function buildLLM(llm: NonNullable<MemStackConfigFile["llm"]>): LLMProvider {
  return llm.provider === "anthropic"
    ? new AnthropicLLMAdapter({ apiKey: llm.apiKey, defaultModel: llm.model })
    : new OpenAILLMAdapter({ apiKey: llm.apiKey, baseURL: llm.baseURL, defaultModel: llm.model });
}

async function checkLLM(llm: LLMProvider): Promise<void> {
  let text: string;
  try {
    // Generous token cap: reasoning models think before they answer.
    ({ text } = await llm.complete({ system: "Reply with the single word OK.", user: "ping", maxTokens: 1024, temperature: 0 }));
  } catch (error) {
    throw new Error(`The LLM provider rejected the test request: ${(error as Error).message}`);
  }
  if (!text.trim()) throw new Error("The LLM provider returned an empty reply to the test request.");
}

// ── connect / disconnect ──

async function connect(ids: string[], flags: HarnessFlags): Promise<number> {
  if (ids.length === 0) throw new Error(`Name a harness: memstack connect <${HARNESS_IDS.join("|")}>`);
  const file = readConfigFile();
  if (!file && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("No MemStack configuration found. Run `memstack init` first.");
  }
  const mcp = findMemstackMcp();
  if (!mcp) {
    throw new Error(`memstack-mcp is not installed. MemStack does not install it for you; run:\n  ${installCommand(file?.storage?.type)}`);
  }

  for (const id of ids) {
    const adapter = harnessAdapter(id);
    const launch = harnessLaunch(mcp, adapter.id);
    const result = await connectHarness({
      adapter,
      launch,
      dryRun: flags["dry-run"],
      instructions: !flags["no-agents-md"],
      hooks: !flags["no-hooks"],
    });
    const instructions = result.plan.instructions;
    const hook = result.plan.hook;
    if (flags["dry-run"]) {
      out(`${adapter.displayName}: the server works (${result.verification.stats}).`);
      const pending = result.plan.steps.length > 0 || (instructions && instructions.change !== "none") || (hook && hook.change !== "none");
      out(pending ? "Would run:" : "Already connected; nothing to change.");
      for (const step of result.plan.steps) out(`  ${describeStep(step)}`);
      if (instructions && instructions.change !== "none") {
        out(`  ${instructions.change === "add" ? "add" : "update"} the marked MemStack block in ${instructions.path}:`);
        for (const line of renderBlock(adapter.instructions!.body, adapter.id).trimEnd().split("\n")) out(`    ${line}`);
      }
      if (hook && hook.change !== "none") {
        out(`  ${hook.change} the MemStack session-start hook in ${hook.path}:`);
        out(`    ${sessionStartHook(launch, adapter.id).command}`);
      }
    } else if (result.changed) {
      out(`✓ Connected ${adapter.displayName}. ${result.verification.stats}`);
      if (instructions && instructions.change !== "none") {
        out(`  ${instructions.change === "add" ? "Added" : "Updated"} MemStack guidance in ${instructions.path} (between memstack:begin/end markers).`);
      }
      if (hook && hook.change !== "none") {
        out(`  ${hook.change === "add" ? "Added" : "Updated"} a session-start hook in ${hook.path} that loads project memories.`);
        if (adapter.id === "codex") out("  Codex runs new hooks only after you approve them: open Codex and run /hooks once.");
      }
      out(`  ${adapter.id === "claude-code" ? "Restart Claude Code" : "Start a new Codex session"} to load MemStack.`);
    } else {
      out(`✓ ${adapter.displayName} is already connected. ${result.verification.stats}`);
    }
  }
  return 0;
}

async function disconnect(ids: string[], flags: HarnessFlags): Promise<number> {
  if (ids.length === 0) throw new Error(`Name a harness: memstack disconnect <${HARNESS_IDS.join("|")}>`);
  for (const id of ids) {
    const adapter = harnessAdapter(id);
    const result = await disconnectHarness({ adapter, dryRun: flags["dry-run"] });
    const removeBlock = result.plan.instructions?.change === "remove";
    const removeHook = result.plan.hook?.change === "remove";
    if (flags["dry-run"]) {
      const pending = result.plan.steps.length > 0 || removeBlock || removeHook;
      out(pending ? `${adapter.displayName}: would run:` : `${adapter.displayName}: not connected; nothing to change.`);
      for (const step of result.plan.steps) out(`  ${describeStep(step)}`);
      if (removeBlock) out(`  remove the marked MemStack block from ${result.plan.instructions!.path}`);
      if (removeHook) out(`  remove the MemStack session-start hook from ${result.plan.hook!.path}`);
    } else {
      out(result.changed ? `✓ Disconnected ${adapter.displayName}. Your memories are kept.` : `${adapter.displayName} was not connected.`);
    }
  }
  return 0;
}

// ── status ──

const label = (name: string) => (name ? `${name}:` : "").padEnd(14);

async function status(): Promise<number> {
  const file = readConfigFile();
  out(`${label("Config")}${file ? configFilePath() : "none (run `memstack init`)"}`);
  if (file?.llm) out(`${label("LLM")}${file.llm.provider}${file.llm.model ? ` (${file.llm.model})` : ""}${file.llm.baseURL ? ` at ${file.llm.baseURL}` : ""}`);
  if (file?.storage) out(`${label("Storage")}${file.storage.type}${file.storage.path ? ` at ${file.storage.path}` : file.storage.url ? " (URL configured)" : ""}`);

  const project = resolveProject();
  out(`${label("Project")}${project.id} (${describeSource(project.source)}: ${project.key})`);

  const mcp = findMemstackMcp();
  out(`${label("Server")}${mcp ?? "memstack-mcp not installed"}`);

  for (const id of HARNESS_IDS) {
    const adapter = harnessAdapter(id);
    const state = await adapter.inspect();
    let line: string;
    if (!state.installed) line = "not installed";
    else if (!state.entry) line = "not connected";
    else if (!mcp) {
      const present = [state.entry.command, ...state.entry.args.filter((a) => a.startsWith("/"))].every((p) => existsSync(p));
      line = present ? "connected (memstack-mcp is not on PATH, so updates can't be checked)" : "connected to a command that no longer exists (run `memstack doctor`)";
    } else if (sameLaunch(state.entry, harnessLaunch(mcp, adapter.id))) line = "connected";
    else line = "connected with a different command (run `memstack connect` to update)";
    out(`${label(adapter.displayName)}${line}`);
    if (adapter.instructions && state.installed) {
      const block = readBlock(adapter.instructions.path);
      const current = block === renderBlock(adapter.instructions.body, adapter.id);
      out(`${label("")}guidance in ${adapter.instructions.path}: ${block === null ? "none" : current ? "present" : "outdated (run `memstack connect`)"}`);
    }
    if (adapter.sessionHook && state.installed) {
      out(`${label("")}session-start hook in ${adapter.sessionHook.path}: ${hookState(adapter, mcp)}`);
    }
  }
  return 0;
}

function hookState(adapter: ReturnType<typeof harnessAdapter>, mcp: string | null): string {
  const current = readHook(adapter.sessionHook!.path);
  if (!current) return "missing";
  if (mcp && JSON.stringify(current) !== JSON.stringify(sessionStartHook(harnessLaunch(mcp, adapter.id), adapter.id))) return "outdated";
  return "present";
}

// ── doctor ──

async function doctor(flags: HarnessFlags): Promise<number> {
  let failures = 0;
  const pass = (message: string) => out(`✓ ${message}`);
  const warn = (message: string) => out(`! ${message}`);
  const fail = (message: string) => {
    failures++;
    out(`✗ ${message}`);
  };

  let file: MemStackConfigFile | undefined;
  try {
    file = readConfigFile();
    if (file) pass(`Config file ${configFilePath()}`);
    else warn(`No config file at ${configFilePath()}; run \`memstack init\`.`);
  } catch (error) {
    fail((error as Error).message);
  }
  for (const warning of checkConfigPermissions()) warn(warning);

  const env = mergeConfigFile(file, process.env);
  if (env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY) {
    pass(`LLM key configured (${env.ANTHROPIC_API_KEY ? "anthropic" : "openai-compatible"}${env.MEMSTACK_LLM_MODEL ? `, ${env.MEMSTACK_LLM_MODEL}` : ""})`);
    if (flags.live && file?.llm && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      try {
        await checkLLM(buildLLM(file.llm));
        pass("LLM provider answered a test request");
      } catch (error) {
        fail((error as Error).message);
      }
    }
  } else {
    fail("No LLM key. Run `memstack init`.");
  }

  const storageType = (env.MEMSTACK_STORAGE ?? "memory") as StorageType;
  if (storageType === "memory") warn("Storage is in-memory: memories are lost when a session ends. Run `memstack init` to choose a store.");
  else pass(`Storage: ${storageType}`);

  const mcp = findMemstackMcp();
  if (!mcp) {
    fail(`memstack-mcp is not installed. Run: ${installCommand(storageType)}`);
  } else {
    pass(`memstack-mcp at ${mcp}`);
    const driver = STORAGE_DRIVERS[storageType];
    if (driver) {
      if (canResolveFrom(mcp, driver.module)) pass(`Storage driver ${driver.module} is installed`);
      else fail(`Storage driver ${driver.module} is not installed next to memstack-mcp. Run: npm install -g ${driver.spec}`);
    }
  }

  const project = resolveProject();
  pass(`Project ${project.id} (${describeSource(project.source)}: ${project.key})`);

  for (const id of HARNESS_IDS) {
    const adapter = harnessAdapter(id);
    let state;
    try {
      state = await adapter.inspect();
    } catch (error) {
      fail(`${adapter.displayName}: ${(error as Error).message}`);
      continue;
    }
    if (!state.installed) {
      out(`- ${adapter.displayName} is not installed`);
      continue;
    }
    if (!state.entry) {
      warn(`${adapter.displayName} is not connected. Run: memstack connect ${id}`);
      continue;
    }
    const missing = [state.entry.command, ...state.entry.args.filter((a) => a.startsWith("/"))].filter((p) => !existsSync(p));
    if (missing.length > 0) fail(`${adapter.displayName} points at ${missing.join(", ")}, which no longer exists. Run: memstack connect ${id}`);
    else if (mcp && !sameLaunch(state.entry, harnessLaunch(mcp, adapter.id))) warn(`${adapter.displayName} uses a different MemStack command. Run: memstack connect ${id}`);
    else pass(`${adapter.displayName} is connected`);
    if (adapter.instructions) {
      const block = readBlock(adapter.instructions.path);
      if (block === null) warn(`${adapter.displayName} has no MemStack guidance in ${adapter.instructions.path}, so it may not save memories when asked. Run: memstack connect ${id}`);
      else if (block !== renderBlock(adapter.instructions.body, adapter.id)) warn(`MemStack guidance in ${adapter.instructions.path} is outdated. Run: memstack connect ${id}`);
      else pass(`${adapter.displayName} guidance in ${adapter.instructions.path}`);
    }
    if (adapter.sessionHook) {
      const hookStatus = hookState(adapter, mcp);
      if (hookStatus === "present") {
        pass(`${adapter.displayName} session-start hook in ${adapter.sessionHook.path}${id === "codex" ? " (approve it once in Codex with /hooks)" : ""}`);
      } else {
        warn(`${adapter.displayName} session-start hook is ${hookStatus}. Run: memstack connect ${id}`);
      }
    }
  }

  if (mcp) {
    const verification = await verifyServer(harnessLaunch(mcp, "claude-code"));
    if (verification.ok) pass(`MCP server starts and answers: ${verification.stats}`);
    else fail(`MCP server check failed: ${verification.error}`);
  }

  out();
  out(failures === 0 ? "No problems found." : `${failures} problem${failures === 1 ? "" : "s"} found.`);
  return failures === 0 ? 0 : 1;
}

// ── memories ──

async function memories(args: string[], flags: HarnessFlags): Promise<number> {
  const { config } = await loadConfig();
  if (!config.storage) throw new Error("No storage configured. Run `memstack init`.");
  const project = resolveProject();
  const namespaces = defaultRecallNamespaces(project.id);
  const memory = new HarnessMemory({ storage: config.storage, llm: config.llm, autoTags: false });

  try {
    await memory.adoptProjects(project.previousIds, project.id);
    if (flags.delete) {
      await memory.forget(flags.delete, namespaces);
      out(`Deleted ${flags.delete}.`);
      return 0;
    }
    const query = args.join(" ").trim() || undefined;
    const { hits, fallback } = await memory.recall({
      namespaces: flags.global ? ["global"] : namespaces,
      query,
      limit: flags.limit ? Number(flags.limit) : 20,
      maxChars: 50_000,
    });
    out(`Project ${project.id} (${project.key})`);
    if (hits.length === 0) {
      out("No memories.");
      return 0;
    }
    if (query && fallback) out(`Nothing matched "${query}". The most important memories instead:`);
    for (const { memory: m } of hits) {
      const source = (m.metadata?.source as { harness?: string } | undefined)?.harness;
      const scope = m.actorId === "global" ? "global" : "project";
      out(`${m.id}  ${m.memoryType}, ${scope}${source ? `, from ${source}` : ""}, ${m.createdAt.toISOString().slice(0, 10)}`);
      out(`  ${m.content}`);
    }
    return 0;
  } finally {
    await config.storage.close();
  }
}

// ── project ──

async function projectCommand(args: string[]): Promise<number> {
  const [sub, value] = args;
  if (sub === "pin") {
    if (!value) throw new Error("Name the project: memstack project pin <id>");
    const before = resolveProject();
    const path = pinProject(value);
    out(`Pinned this repository to project "${value}" in ${path}. Commit it so every clone uses the same project.`);
    if (before.id !== value) {
      out(`Memories stored under the previous ID stay there. To move them: memstack project merge ${before.id}`);
    }
    return 0;
  }

  if (sub === "merge") {
    if (!value) throw new Error("Name the old project ID: memstack project merge <old-id>");
    const oldId = value.replace(/^project:/, "");
    const project = resolveProject();
    const { config } = await loadConfig();
    if (!config.storage) throw new Error("No storage configured. Run `memstack init`.");
    const memory = new HarnessMemory({ storage: config.storage, llm: config.llm, autoTags: false });
    try {
      const moved = await memory.moveNamespace(projectNamespace(oldId), projectNamespace(project.id));
      out(`Moved ${moved} ${moved === 1 ? "memory" : "memories"} from ${oldId} to ${project.id}.`);
    } finally {
      await config.storage.close();
    }
    return 0;
  }

  if (sub) throw new Error(`Unknown subcommand "${sub}". Use: memstack project [pin <id> | merge <old-id>]`);

  const project = resolveProject();
  out(`${label("Project")}${project.id}`);
  out(`${label("From")}${describeSource(project.source)}: ${project.key}`);
  out(`${label("Root")}${project.root}`);
  return 0;
}

function describeSource(source: string): string {
  switch (source) {
    case "pin":
      return `pinned in ${PIN_FILE}`;
    case "root-commit":
      return "first commit";
    case "remote":
      return "origin remote (shallow clone)";
    case "git":
      return "git directory (no commits yet)";
    default:
      return "directory";
  }
}

// ── prompts ──

interface Prompter {
  ask(question: string, fallback: string): Promise<string>;
  choose(question: string, options: string[], fallback: string): Promise<string>;
  secret(question: string): Promise<string>;
  close(): void;
}

function createPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const output = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WriteStream };
  const write = output._writeToOutput.bind(rl);
  // Hide typed characters while a secret is entered.
  output._writeToOutput = (text: string) => {
    if (!muted || text.includes("\n") || text.includes("\r")) write(text);
  };

  return {
    async ask(question, fallback) {
      const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
      return answer || fallback;
    },
    async choose(question, options, fallback) {
      for (;;) {
        const answer = (await rl.question(`${question} (${options.join(", ")}) [${fallback}]: `)).trim() || fallback;
        if (options.includes(answer)) return answer;
        out(`Choose one of: ${options.join(", ")}`);
      }
    },
    async secret(question) {
      const pending = rl.question(`${question}: `);
      muted = true;
      try {
        return (await pending).trim();
      } finally {
        muted = false;
        out();
      }
    },
    close() {
      rl.close();
    },
  };
}
