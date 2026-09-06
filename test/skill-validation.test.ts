import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("skill validation", () => {
  it("accepts the published MemStack agent skill", async () => {
    await expect(
      execFileAsync("node", ["scripts/verify-skill.mjs"], { cwd: process.cwd() }),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("rejects a skill that does not link to its reference", async () => {
    const skillDir = join(await mkdtemp(join(tmpdir(), "memstack-skill-")), "skill");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: example\ndescription: Example skill\n---\n\nmemstack store --actor example --content example\n");
    await writeFile(join(skillDir, "REFERENCE.md"), "# Reference\n");

    await expect(
      execFileAsync("node", ["scripts/verify-skill.mjs", "--skill-dir", skillDir], { cwd: process.cwd() }),
    ).rejects.toThrow("must link to REFERENCE.md");
  });

  it("rejects documentation that uses a nonexistent CLI command", async () => {
    const skillDir = join(await mkdtemp(join(tmpdir(), "memstack-skill-")), "skill");
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: example\ndescription: Example skill\n---\n\nSee [REFERENCE.md](REFERENCE.md).\n\nmemstack nonexistent --actor example\n",
    );
    await writeFile(join(skillDir, "REFERENCE.md"), "# Reference\n");

    await expect(
      execFileAsync("node", ["scripts/verify-skill.mjs", "--skill-dir", skillDir], { cwd: process.cwd() }),
    ).rejects.toThrow("Unknown MemStack CLI command");
  });
});
