import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_INSTRUCTIONS, readBlock, removeBlock, renderBlock, upsertBlock } from "../src/harness/instructions.js";

describe("managed instruction block", () => {
  let dir: string;
  let file: string;
  let backups: string;
  const block = renderBlock(CODEX_INSTRUCTIONS, "codex");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memstack-agents-"));
    file = join(dir, "AGENTS.md");
    backups = join(dir, "backups");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the file when it does not exist, and deletes it again on removal", () => {
    expect(upsertBlock(file, block, backups)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(block);
    expect(readBlock(file)).toBe(block);

    expect(removeBlock(file, backups)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("appends to an existing file and restores it byte for byte on removal", () => {
    const original = "# My rules\n\nAlways write tests.\n";
    writeFileSync(file, original);

    upsertBlock(file, block, backups);
    const withBlock = readFileSync(file, "utf8");
    expect(withBlock.startsWith(original)).toBe(true);
    expect(withBlock).toContain("<!-- memstack:begin (managed by `memstack connect codex`");
    expect(withBlock.trimEnd().endsWith("<!-- memstack:end -->")).toBe(true);

    removeBlock(file, backups);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("handles a file without a trailing newline", () => {
    writeFileSync(file, "no newline");
    upsertBlock(file, block, backups);
    removeBlock(file, backups);
    expect(readFileSync(file, "utf8")).toBe("no newline\n");
  });

  it("is idempotent and replaces an outdated block in place", () => {
    writeFileSync(file, "before\n");
    upsertBlock(file, renderBlock("old guidance", "codex"), backups);
    writeFileSync(file, `${readFileSync(file, "utf8")}\nafter\n`);

    expect(upsertBlock(file, block, backups)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).not.toContain("old guidance");
    expect(content.match(/memstack:begin/g)).toHaveLength(1);
    expect(content.startsWith("before\n")).toBe(true);
    expect(content.endsWith("\nafter\n")).toBe(true);

    expect(upsertBlock(file, block, backups)).toBe(false);
  });

  it("backs up the file before each change", () => {
    writeFileSync(file, "mine\n");
    upsertBlock(file, block, backups);
    removeBlock(file, backups);
    const saved = readdirSync(backups);
    expect(saved).toHaveLength(2);
    expect(saved.every((name) => name.startsWith("AGENTS.md."))).toBe(true);
  });

  it("keeps every backup when changes land in the same millisecond", () => {
    writeFileSync(file, "mine\n");
    const now = Date.prototype.toISOString;
    Date.prototype.toISOString = () => "2026-09-30T12:00:00.000Z";
    try {
      upsertBlock(file, block, backups);
      removeBlock(file, backups);
      upsertBlock(file, block, backups);
    } finally {
      Date.prototype.toISOString = now;
    }
    expect(readdirSync(backups).sort()).toEqual([
      "AGENTS.md.2026-09-30T12-00-00-000Z",
      "AGENTS.md.2026-09-30T12-00-00-000Z-1",
      "AGENTS.md.2026-09-30T12-00-00-000Z-2",
    ]);
  });

  it("does nothing when removing an absent block", () => {
    writeFileSync(file, "mine\n");
    expect(removeBlock(file, backups)).toBe(false);
    expect(removeBlock(join(dir, "missing.md"), backups)).toBe(false);
    expect(existsSync(backups)).toBe(false);
  });
});
