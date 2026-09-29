import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemote, resolveProject } from "../src/project.js";

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
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

  function repo(name: string, remote?: string): string {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q");
    if (remote) git(path, "remote", "add", "origin", remote);
    return path;
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "memstack-project-")));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("gives clones of the same remote the same ID, whatever the URL form", () => {
    const https = resolveProject(repo("a", "https://github.com/isiomaC/memstack.git"));
    const ssh = resolveProject(repo("b", "git@github.com:isiomaC/memstack.git"));
    expect(https.source).toBe("remote");
    expect(https.key).toBe("github.com/isiomaC/memstack");
    expect(ssh.id).toBe(https.id);
    expect(https.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives different remotes different IDs", () => {
    const a = resolveProject(repo("a", "git@github.com:acme/api.git"));
    const b = resolveProject(repo("b", "git@github.com:acme/web.git"));
    expect(a.id).not.toBe(b.id);
  });

  it("resolves the same project from any subdirectory", () => {
    const root = repo("mono", "git@github.com:acme/mono.git");
    mkdirSync(join(root, "packages", "api"), { recursive: true });
    const nested = resolveProject(join(root, "packages", "api"));
    expect(nested.id).toBe(resolveProject(root).id);
    expect(nested.root).toBe(root);
  });

  it("shares an ID between worktrees of a repository without a remote", () => {
    const root = repo("local");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(dir, "local-wt");
    git(root, "worktree", "add", "-q", worktree);

    const main = resolveProject(root);
    expect(main.source).toBe("git");
    expect(resolveProject(worktree).id).toBe(main.id);
  });

  it("falls back to the directory outside git", () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const project = resolveProject(plain);
    expect(project).toMatchObject({ source: "directory", key: plain, root: plain });
  });
});
