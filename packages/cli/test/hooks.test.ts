import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHook, removeHook, sessionStartHook, upsertHook } from "../src/harness/hooks.js";

const launch = { command: "/usr/local/bin/node", args: ["/opt/My Tools/@memstack/mcp/dist/cli.js", "--profile", "harness", "--harness", "codex"] };
const hook = sessionStartHook(launch, "codex");

describe("sessionStartHook", () => {
  it("runs the installed script's hook subcommand, quoting paths with spaces", () => {
    expect(hook).toEqual({
      type: "command",
      command: "/usr/local/bin/node '/opt/My Tools/@memstack/mcp/dist/cli.js' hook session-start --harness codex",
      timeout: 10,
      statusMessage: "Loading MemStack project memory",
    });
  });

  it("runs a binary launch directly", () => {
    expect(sessionStartHook({ command: "/usr/bin/memstack-mcp", args: ["--profile", "harness"] }, "claude-code").command).toBe(
      "/usr/bin/memstack-mcp hook session-start --harness claude-code"
    );
  });
});

describe("hooks file", () => {
  let dir: string;
  let file: string;
  let backups: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memstack-hooks-"));
    file = join(dir, "settings.json");
    backups = join(dir, "backups");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const json = () => JSON.parse(readFileSync(file, "utf8"));

  it("creates the file when missing and deletes it again on removal", () => {
    expect(upsertHook(file, hook, "startup|resume", backups)).toBe(true);
    expect(json()).toEqual({ hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [hook] }] } });
    expect(readHook(file)).toEqual(hook);

    expect(removeHook(file, backups)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("keeps other settings and hooks, and restores them exactly on removal", () => {
    const original = {
      model: "opus",
      permissions: { allow: ["Bash(git status)"] },
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }],
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      },
    };
    writeFileSync(file, JSON.stringify(original, null, 2));

    upsertHook(file, hook, "startup|resume", backups);
    const withOurs = json();
    expect(withOurs.model).toBe("opus");
    expect(withOurs.hooks.Stop).toEqual(original.hooks.Stop);
    expect(withOurs.hooks.SessionStart).toEqual([...original.hooks.SessionStart, { matcher: "startup|resume", hooks: [hook] }]);

    removeHook(file, backups);
    expect(json()).toEqual(original);
  });

  it("is idempotent, and replaces an outdated entry in place of adding another", () => {
    const old = { ...hook, command: "/old/node /old/cli.js hook session-start --harness codex" };
    upsertHook(file, old, "startup", backups);
    expect(upsertHook(file, hook, "startup|resume", backups)).toBe(true);
    expect(json().hooks.SessionStart).toEqual([{ matcher: "startup|resume", hooks: [hook] }]);
    expect(upsertHook(file, hook, "startup|resume", backups)).toBe(false);
  });

  it("removes only its own hook from a shared matcher group", () => {
    writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }, hook] }] } }));
    removeHook(file, backups);
    expect(json()).toEqual({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }] } });
  });

  it("leaves a file that is not valid JSON unchanged", () => {
    writeFileSync(file, "{ // comment\n}");
    expect(() => upsertHook(file, hook, "startup", backups)).toThrow(/not valid JSON, so MemStack left it unchanged/);
    expect(readFileSync(file, "utf8")).toBe("{ // comment\n}");
  });

  it.each([
    ["tabs", "\t", "\n"],
    ["four spaces", "    ", "\n"],
    ["no trailing newline", "  ", ""],
  ])("keeps a file's formatting (%s) and restores it byte for byte", (_name, indent, newline) => {
    const original = `${JSON.stringify({ model: "opus", env: { A: "1" } }, null, indent)}${newline}`;
    writeFileSync(file, original);
    upsertHook(file, hook, "startup", backups);
    expect(readFileSync(file, "utf8")).toContain(`${indent}"hooks"`);
    removeHook(file, backups);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("backs up an existing file before changing it", () => {
    writeFileSync(file, "{}");
    upsertHook(file, hook, "startup", backups);
    expect(existsSync(backups)).toBe(true);
  });

  it("does nothing when removing an absent hook", () => {
    writeFileSync(file, JSON.stringify({ model: "opus" }));
    expect(removeHook(file, backups)).toBe(false);
    expect(removeHook(join(dir, "missing.json"), backups)).toBe(false);
  });
});
