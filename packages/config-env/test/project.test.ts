import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemote, pinProject, resolveProject } from "../src/project.js";

describe("normalizeRemote", () => {
  it.each([
    ["https://github.com/isiomaC/memstack.git", "github.com/isiomaC/memstack"],
    ["https://user:token@GitHub.com/isiomaC/memstack", "github.com/isiomaC/memstack"],
    ["ssh://git@github.com:22/isiomaC/memstack.git", "github.com/isiomaC/memstack"],
    ["git@github.com:isiomaC/memstack.git", "github.com/isiomaC/memstack"],
    ["github.com:isiomaC/memstack/", "github.com/isiomaC/memstack"],
    ["https://gitlab.example.com/group/sub/repo.git", "gitlab.example.com/group/sub/repo"],
  ])("%s -> %s", (url, expected) => {
    expect(normalizeRemote(url)).toBe(expected);
  });

  it.each(["", "/srv/git/repo.git", "../repo", "file:///srv/git/repo.git", "https://github.com/"])(
    "returns null for %j",
    (url) => expect(normalizeRemote(url)).toBeNull()
  );
});

describe("resolveProject", () => {
  let dir: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], {
      stdio: "ignore",
    });

  function repo(name: string, { commit = true, remote }: { commit?: boolean; remote?: string } = {}): string {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q");
    if (remote) git(path, "remote", "add", "origin", remote);
    if (commit) {
      writeFileSync(join(path, `${name}.md`), `# ${name}\n`);
      git(path, "add", ".");
      git(path, "commit", "-q", "-m", "init");
    }
    return path;
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "memstack-project-")));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("derives the ID from the first commit", () => {
    const project = resolveProject(repo("a"));
    expect(project.source).toBe("root-commit");
    expect(project.key).toMatch(/^[0-9a-f]{40}$/);
    expect(project.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keeps the ID when a remote is added or renamed", () => {
    const path = repo("a");
    const before = resolveProject(path).id;
    git(path, "remote", "add", "origin", "git@github.com:acme/api.git");
    expect(resolveProject(path).id).toBe(before);
    git(path, "remote", "set-url", "origin", "https://github.com/acme-renamed/api-v2.git");
    expect(resolveProject(path).id).toBe(before);
  });

  it("keeps the ID when the folder moves", () => {
    const path = repo("a");
    const before = resolveProject(path).id;
    renameSync(path, join(dir, "moved"));
    expect(resolveProject(join(dir, "moved")).id).toBe(before);
  });

  it("gives clones the same ID and unrelated repositories different IDs", () => {
    const origin = repo("origin");
    git(dir, "clone", "-q", origin, join(dir, "clone"));
    expect(resolveProject(join(dir, "clone")).id).toBe(resolveProject(origin).id);
    expect(resolveProject(repo("other")).id).not.toBe(resolveProject(origin).id);
  });

  it("resolves the same project from any subdirectory and worktree", () => {
    const root = repo("mono");
    mkdirSync(join(root, "packages", "api"), { recursive: true });
    const worktree = join(dir, "mono-wt");
    git(root, "worktree", "add", "-q", worktree);

    const main = resolveProject(root);
    expect(resolveProject(join(root, "packages", "api"))).toMatchObject({ id: main.id, root });
    expect(resolveProject(worktree).id).toBe(main.id);
  });

  it("does not change when an unrelated history is merged", () => {
    const path = repo("a");
    const before = resolveProject(path).id;
    const other = repo("other");
    git(path, "fetch", "-q", other, "HEAD");
    git(path, "merge", "-q", "--allow-unrelated-histories", "-m", "merge", "FETCH_HEAD");
    expect(resolveProject(path).id).toBe(before);
  });

  it("uses the git directory before the first commit, then lists it as a previous ID", () => {
    const path = repo("fresh", { commit: false });
    const before = resolveProject(path);
    expect(before.source).toBe("git");

    writeFileSync(join(path, "a.txt"), "a");
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "first");
    const after = resolveProject(path);
    expect(after.source).toBe("root-commit");
    expect(after.id).not.toBe(before.id);
    expect(after.previousIds).toContain(before.id);
  });

  it("lists the directory ID as previous after `git init` in a plain folder", () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const before = resolveProject(plain);
    expect(before).toMatchObject({ source: "directory", key: plain, root: plain, previousIds: [] });

    git(plain, "init", "-q");
    expect(resolveProject(plain).previousIds).toContain(before.id);
  });

  it("uses the remote for shallow clones, whose first commit is unknown", () => {
    const origin = repo("origin");
    writeFileSync(join(origin, "b.txt"), "b");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "second");
    git(dir, "clone", "-q", "--depth", "1", `file://${origin}`, join(dir, "shallow"));

    git(join(dir, "shallow"), "remote", "set-url", "origin", "git@github.com:acme/api.git");

    expect(resolveProject(join(dir, "shallow"))).toMatchObject({ source: "remote", key: "github.com/acme/api" });
  });

  describe("pinned projects", () => {
    it("prefers the pinned ID over everything else", () => {
      const path = repo("a");
      writeFileSync(join(path, ".memstack.json"), JSON.stringify({ project: "acme-api" }));
      mkdirSync(join(path, "src"));
      expect(resolveProject(join(path, "src"))).toMatchObject({ id: "acme-api", source: "pin", root: path, previousIds: [] });
    });

    it("pins at the repository root and keeps other keys in the file", () => {
      const path = repo("a");
      mkdirSync(join(path, "src"));
      writeFileSync(join(path, ".memstack.json"), JSON.stringify({ note: "keep" }));

      expect(pinProject("acme-api", join(path, "src"))).toBe(join(path, ".memstack.json"));
      expect(JSON.parse(readFileSync(join(path, ".memstack.json"), "utf8"))).toEqual({ note: "keep", project: "acme-api" });
      expect(resolveProject(path).id).toBe("acme-api");
    });

    it("rejects invalid pinned IDs", () => {
      const path = repo("a");
      expect(() => pinProject("../escape", path)).toThrow(/letters, digits/);
      writeFileSync(join(path, ".memstack.json"), JSON.stringify({ project: "has spaces" }));
      expect(() => resolveProject(path)).toThrow(/"project" must use/);
    });
  });
});
