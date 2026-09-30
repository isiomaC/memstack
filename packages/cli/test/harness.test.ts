import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeAdapter } from "../src/harness/claude-code.js";
import { codexAdapter } from "../src/harness/codex.js";
import { connectHarness, describeStep, disconnectHarness } from "../src/harness/connect.js";
import { createRunner, type RunResult, type Runner } from "../src/harness/exec.js";
import { canResolveFrom, findMemstackMcp, harnessLaunch, installCommand } from "../src/harness/locate.js";
import type { HarnessAdapter, ServerLaunch } from "../src/harness/types.js";
import type { Verifier } from "../src/harness/verify.js";

const launch: ServerLaunch = { command: "/usr/bin/node", args: ["/opt/mcp/dist/cli.js", "--profile", "harness", "--harness", "codex"] };
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const okVerify: Verifier = async () => ({ ok: true, stats: "Project p: 0 memories. Global: 0." });

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "memstack-cli-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("claudeCodeAdapter", () => {
  it("reads the user-scope entry from $CLAUDE_CONFIG_DIR/.claude.json", async () => {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ projects: {}, mcpServers: { memstack: { type: "stdio", ...launch } } }));
    const adapter = claudeCodeAdapter({ env: { CLAUDE_CONFIG_DIR: dir }, runner: async () => ok("2.1.285 (Claude Code)") });
    expect(await adapter.inspect()).toEqual({ installed: true, version: "2.1.285", configPath: join(dir, ".claude.json"), entry: launch });
  });

  it("reports no entry when the file or server is absent", async () => {
    const adapter = claudeCodeAdapter({ env: { CLAUDE_CONFIG_DIR: dir }, runner: async () => ok("2.1.285") });
    expect((await adapter.inspect()).entry).toBeUndefined();
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect((await adapter.inspect()).entry).toBeUndefined();
  });

  it("reports a missing CLI as not installed", async () => {
    const adapter = claudeCodeAdapter({ env: { CLAUDE_CONFIG_DIR: dir }, runner: async () => ({ code: 127, stdout: "", stderr: "" }) });
    expect((await adapter.inspect()).installed).toBe(false);
  });

  it("adds and removes at user scope through the claude CLI", () => {
    const adapter = claudeCodeAdapter({ env: { CLAUDE_CONFIG_DIR: dir } });
    expect(adapter.addSteps(launch)).toEqual([
      { command: "claude", args: ["mcp", "add-json", "-s", "user", "memstack", JSON.stringify({ type: "stdio", ...launch })] },
    ]);
    expect(adapter.removeSteps()).toEqual([{ command: "claude", args: ["mcp", "remove", "-s", "user", "memstack"] }]);
  });
});

describe("codexAdapter", () => {
  const getJson = JSON.stringify({ name: "memstack", transport: { type: "stdio", ...launch, env: null, env_vars: [], cwd: null } });

  it("reads the entry with codex mcp get --json", async () => {
    const runner: Runner = async (_c, args) => (args[0] === "--version" ? ok("codex-cli 0.158.0") : ok(getJson));
    const state = await codexAdapter({ env: { CODEX_HOME: dir }, runner }).inspect();
    expect(state).toEqual({ installed: true, version: "0.158.0", configPath: join(dir, "config.toml"), entry: launch });
  });

  it("treats 'No MCP server named' as not connected, and other failures as errors", async () => {
    const missing: Runner = async (_c, args) =>
      args[0] === "--version" ? ok("codex-cli 0.158.0") : { code: 1, stdout: "", stderr: "Error: No MCP server named 'memstack' found." };
    expect((await codexAdapter({ runner: missing }).inspect()).entry).toBeUndefined();

    const broken: Runner = async (_c, args) => (args[0] === "--version" ? ok("codex-cli 0.158.0") : { code: 1, stdout: "", stderr: "config.toml: invalid TOML" });
    await expect(codexAdapter({ runner: broken }).inspect()).rejects.toThrow(/invalid TOML/);
  });

  it("adds with -- before the server command, passing env as flags", () => {
    expect(codexAdapter().addSteps({ ...launch, env: { A: "1" } })).toEqual([
      { command: "codex", args: ["mcp", "add", "memstack", "--env", "A=1", "--", launch.command, ...launch.args] },
    ]);
  });
});

/** An in-memory harness for orchestration tests. */
function fakeHarness(initial?: ServerLaunch, failOnce?: string) {
  let failOn = failOnce;
  let entry = initial;
  const calls: string[][] = [];
  const adapter: HarnessAdapter = {
    id: "codex",
    displayName: "Fake",
    binary: "fake",
    inspect: async () => ({ installed: true, configPath: "/fake", entry }),
    addSteps: (l) => [{ command: "fake", args: ["add", JSON.stringify(l)] }],
    removeSteps: () => [{ command: "fake", args: ["remove"] }],
  };
  const runner: Runner = async (_c, args) => {
    calls.push(args);
    if (args[0] === failOn) {
      failOn = undefined;
      return { code: 1, stdout: "", stderr: `${args[0]} broke` };
    }
    if (args[0] === "add") entry = JSON.parse(args[1]);
    if (args[0] === "remove") entry = undefined;
    return ok();
  };
  return { adapter, runner, calls, entry: () => entry };
}

describe("connectHarness", () => {
  it("adds the entry and confirms the harness reads it", async () => {
    const h = fakeHarness();
    const result = await connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify });
    expect(result.changed).toBe(true);
    expect(h.entry()).toEqual(launch);
  });

  it("is idempotent", async () => {
    const h = fakeHarness(launch);
    const result = await connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify });
    expect(result.changed).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("replaces an outdated entry", async () => {
    const h = fakeHarness({ command: "/old/memstack-mcp", args: [] });
    await connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify });
    expect(h.calls.map((c) => c[0])).toEqual(["remove", "add"]);
    expect(h.entry()).toEqual(launch);
  });

  it("changes nothing when the server fails verification", async () => {
    const h = fakeHarness();
    const verify: Verifier = async () => ({ ok: false, error: "SQLite requires better-sqlite3. Install: npm install better-sqlite3@^11.10.0" });
    await expect(connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify })).rejects.toThrow(
      /was not changed: SQLite requires better-sqlite3/
    );
    expect(h.calls).toEqual([]);
  });

  it("restores the previous entry when a step fails part-way", async () => {
    const old = { command: "/old/memstack-mcp", args: [] };
    const h = fakeHarness(old, "add");
    await expect(connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify })).rejects.toThrow(
      /add broke.*restored/
    );
    expect(h.entry()).toEqual(old);
  });

  it("says so when restoring fails too", async () => {
    const h = fakeHarness({ command: "/old/memstack-mcp", args: [] }, "add");
    h.adapter.addSteps = () => [{ command: "fake", args: ["add-broken"] }];
    const runner: Runner = async (c, args) => (args[0] === "add-broken" ? { code: 1, stdout: "", stderr: "nope" } : h.runner(c, args));
    await expect(connectHarness({ adapter: h.adapter, launch, runner, verify: okVerify })).rejects.toThrow(/Restoring the previous configuration failed/);
  });

  it("changes nothing on a dry run", async () => {
    const h = fakeHarness();
    const result = await connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify, dryRun: true });
    expect(result.plan.steps).toHaveLength(1);
    expect(h.calls).toEqual([]);
  });

  it("fails clearly when the harness is not installed", async () => {
    const h = fakeHarness();
    h.adapter.inspect = async () => ({ installed: false, configPath: "/fake" });
    await expect(connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify })).rejects.toThrow(/not installed/);
  });
});

describe("instruction files", () => {
  it("adds the block after connecting, and removes it on disconnect", async () => {
    const h = fakeHarness();
    const path = join(dir, "AGENTS.md");
    h.adapter.instructions = { path, body: "Use memory_store." };

    const dry = await connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify, dryRun: true, backupDir: join(dir, "b") });
    expect(dry.plan.instructions).toEqual({ path, change: "add" });
    expect(existsSync(path)).toBe(false);

    await connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify, backupDir: join(dir, "b") });
    expect(readFileSync(path, "utf8")).toContain("Use memory_store.");

    const again = await connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify, backupDir: join(dir, "b") });
    expect(again.changed).toBe(false);

    const removed = await disconnectHarness({ adapter: h.adapter, runner: h.runner, backupDir: join(dir, "b") });
    expect(removed.plan.instructions).toEqual({ path, change: "remove" });
    expect(existsSync(path)).toBe(false);
  });

  it("adds the block to an already-connected harness", async () => {
    const h = fakeHarness(launch);
    const path = join(dir, "AGENTS.md");
    h.adapter.instructions = { path, body: "Use memory_store." };
    const result = await connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify, backupDir: join(dir, "b") });
    expect(result.changed).toBe(true);
    expect(h.calls).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it("skips the block when instructions is false", async () => {
    const h = fakeHarness();
    const path = join(dir, "AGENTS.md");
    h.adapter.instructions = { path, body: "Use memory_store." };
    const result = await connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify, instructions: false });
    expect(result.plan.instructions).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("rolls back the MCP entry when the block cannot be written", async () => {
    const h = fakeHarness();
    writeFileSync(join(dir, "not-a-dir"), "");
    h.adapter.instructions = { path: join(dir, "not-a-dir", "AGENTS.md"), body: "x" };
    await expect(connectHarness({ adapter: h.adapter, launch, runner: h.runner, verify: okVerify, backupDir: join(dir, "b") })).rejects.toThrow(
      /Could not update .*previous configuration was restored/
    );
    expect(h.entry()).toBeUndefined();
  });

  it("points Codex at $CODEX_HOME/AGENTS.md", () => {
    expect(codexAdapter({ env: { CODEX_HOME: dir } }).instructions?.path).toBe(join(dir, "AGENTS.md"));
    expect(claudeCodeAdapter({ env: { CLAUDE_CONFIG_DIR: dir } }).instructions).toBeUndefined();
  });
});

describe("disconnectHarness", () => {
  it("removes the entry and is a no-op when already removed", async () => {
    const h = fakeHarness(launch);
    expect((await disconnectHarness({ adapter: h.adapter, runner: h.runner })).changed).toBe(true);
    expect(h.entry()).toBeUndefined();
    expect((await disconnectHarness({ adapter: h.adapter, runner: h.runner })).changed).toBe(false);
  });
});

describe("locating the user's install", () => {
  it("finds memstack-mcp on PATH and resolves symlinks", () => {
    const bin = join(dir, "bin");
    const pkg = join(dir, "lib", "node_modules", "@memstack", "mcp", "dist");
    mkdirSync(bin, { recursive: true });
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "cli.js"), "#!/usr/bin/env node\n");
    execFileSync("ln", ["-s", join(pkg, "cli.js"), join(bin, "memstack-mcp")]);

    expect(findMemstackMcp({ PATH: `/nonexistent:${bin}` })).toBe(join(pkg, "cli.js"));
    expect(findMemstackMcp({ PATH: "/nonexistent" })).toBeNull();
  });

  it("checks for a driver installed next to the server, as a global npm install does", () => {
    const script = join(dir, "lib", "node_modules", "@memstack", "mcp", "dist", "cli.js");
    mkdirSync(join(script, ".."), { recursive: true });
    expect(canResolveFrom(script, "better-sqlite3")).toBe(false);
    mkdirSync(join(dir, "lib", "node_modules", "better-sqlite3"), { recursive: true });
    writeFileSync(join(dir, "lib", "node_modules", "better-sqlite3", "package.json"), "{}");
    expect(canResolveFrom(script, "better-sqlite3")).toBe(true);
  });

  it("launches a script with the current Node binary and harness arguments", () => {
    expect(harnessLaunch("/opt/mcp/dist/cli.js", "codex")).toEqual({
      command: process.execPath,
      args: ["/opt/mcp/dist/cli.js", "--profile", "harness", "--harness", "codex"],
    });
  });

  it("names the driver in the install command, and never installs it", () => {
    expect(installCommand("sqlite")).toBe("npm install -g @memstack/mcp better-sqlite3@^11.10.0");
    expect(installCommand("postgres")).toBe("npm install -g @memstack/mcp postgres@^3.4.9");
    expect(installCommand("disk")).toBe("npm install -g @memstack/mcp");
  });
});

it("describeStep quotes JSON arguments", () => {
  expect(describeStep({ command: "claude", args: ["mcp", "add-json", "memstack", '{"a":1}'] })).toBe(`claude mcp add-json memstack '{"a":1}'`);
});

// Real harness CLIs against throwaway config directories. Skipped where
// the CLIs are not installed, such as CI.
const hasCli = (name: string) => {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe.each([
  ["claude-code", "claude", "CLAUDE_CONFIG_DIR"],
  ["codex", "codex", "CODEX_HOME"],
] as const)("real %s CLI in a temp config dir", (id, binary, homeVar) => {
  it.skipIf(!hasCli(binary))("connects, reconnects without changes, and disconnects", async () => {
    const env = { ...process.env, [homeVar]: dir };
    const adapter = id === "claude-code" ? claudeCodeAdapter({ env }) : codexAdapter({ env });
    const runner = createRunner(env);
    const target = harnessLaunch("/opt/memstack/mcp/dist/cli.js", id);

    const first = await connectHarness({ adapter, launch: target, runner, verify: okVerify, backupDir: join(dir, "backups") });
    expect(first.changed).toBe(true);
    expect((await adapter.inspect()).entry).toEqual(target);

    const second = await connectHarness({ adapter, launch: target, runner, verify: okVerify, backupDir: join(dir, "backups") });
    expect(second.changed).toBe(false);

    if (id === "codex") expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("memstack:begin");
    const removed = await disconnectHarness({ adapter, runner, backupDir: join(dir, "backups") });
    expect(removed.changed).toBe(true);
    expect((await adapter.inspect()).entry).toBeUndefined();
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  }, 60_000);
});
