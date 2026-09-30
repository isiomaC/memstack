// Project identity shared by every harness (ADR 0001, D3). The ID is derived
// from the repository itself every time, with no stored state, so it survives
// remote changes, moves, new clones, new machines, and switching storage.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ProjectSource = "pin" | "root-commit" | "remote" | "git" | "directory";

export interface ProjectIdentity {
  /** Stable ID used in `project:<id>` namespaces. */
  id: string;
  source: ProjectSource;
  /** What the ID was derived from: the pinned name, commit hash, remote, or path. */
  key: string;
  /** Git working tree root, or the directory itself outside git. */
  root: string;
  /**
   * IDs this project had before a more stable source became available,
   * e.g. before its first commit. Memories under them are adopted once.
   */
  previousIds: string[];
}

export const PIN_FILE = ".memstack.json";
const PIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Resolves the project for a working directory, preferring, in order:
 *
 * 1. a pinned ID in `.memstack.json` at the repository root, shared by the team;
 * 2. the repository's first commit on its main line, which every clone shares
 *    and which survives adding or renaming a remote and moving the folder;
 * 3. the normalized `origin` remote, for shallow clones whose first commit is
 *    not available;
 * 4. the shared git directory, for repositories without commits, so worktrees
 *    still match;
 * 5. the directory, outside git.
 */
export function resolveProject(cwd: string = process.cwd()): ProjectIdentity {
  const dir = realpathSync(resolve(cwd));
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  const base = root ?? dir;

  const pinned = readPin(base);
  const fallbacks = transitionalIds(dir, root);

  if (pinned) return { id: pinned, source: "pin", key: pinned, root: base, previousIds: [] };
  if (!root) return { ...identity("directory", dir), root: dir, previousIds: [] };

  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]) === "true";
  const rootCommit = shallow ? null : firstCommit(root);
  if (rootCommit) return { ...identity("root-commit", rootCommit), root, previousIds: fallbacks };

  const remote = git(root, ["config", "--get", "remote.origin.url"]);
  const normalized = shallow && remote ? normalizeRemote(remote) : null;
  if (normalized) return { ...identity("remote", normalized), root, previousIds: fallbacks };

  const gitId = identity("git", gitRepoKey(root));
  return { ...gitId, root, previousIds: fallbacks.filter((id) => id !== gitId.id) };
}

/**
 * Writes `.memstack.json` with a pinned project ID at the repository root.
 * Commit the file so every clone and teammate uses the same project.
 */
export function pinProject(name: string, cwd: string = process.cwd()): string {
  if (!PIN_PATTERN.test(name)) {
    throw new Error("A pinned project ID uses letters, digits, '.', '_', or '-', starts with a letter or digit, and is at most 64 characters.");
  }
  const dir = realpathSync(resolve(cwd));
  const base = git(dir, ["rev-parse", "--show-toplevel"]) ?? dir;
  const path = join(base, PIN_FILE);
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(path, `${JSON.stringify({ ...existing, project: name }, null, 2)}\n`);
  return path;
}

/**
 * Reduces a git remote URL to `host/path` without protocol, credentials,
 * port, or `.git` suffix, so https, ssh, and scp-style URLs of the same
 * repository match. Returns null for local paths and unparseable values.
 */
export function normalizeRemote(url: string): string | null {
  const value = url.trim();
  if (!value) return null;

  let host: string;
  let path: string;
  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:" || !parsed.hostname) return null;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    return null;
  }

  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!path) return null;
  return `${host.toLowerCase()}/${path}`;
}

function readPin(base: string): string | null {
  const path = join(base, PIN_FILE);
  if (!existsSync(path)) return null;
  let project: unknown;
  try {
    project = (JSON.parse(readFileSync(path, "utf8")) as { project?: unknown }).project;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (project === undefined) return null;
  if (typeof project !== "string" || !PIN_PATTERN.test(project)) {
    throw new Error(`${path}: "project" must use letters, digits, '.', '_', or '-' and be at most 64 characters.`);
  }
  return project;
}

// The first-parent root: merging an unrelated history later does not change it.
function firstCommit(root: string): string | null {
  const out = git(root, ["rev-list", "--max-parents=0", "--first-parent", "HEAD"]);
  return out ? out.split("\n").pop()!.trim() : null;
}

function gitRepoKey(root: string): string {
  const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return commonDir ? dirname(realpathSync(commonDir)) : root;
}

// IDs a repository has before its first commit: its git directory, and the
// working directory it was opened from.
function transitionalIds(dir: string, root: string | null): string[] {
  const ids = new Set<string>();
  if (root) ids.add(identity("git", gitRepoKey(root)).id);
  ids.add(identity("directory", dir).id);
  return [...ids];
}

function identity(source: Exclude<ProjectSource, "pin">, key: string): { id: string; source: ProjectSource; key: string } {
  const id = createHash("sha256").update(`${source}:${key}`).digest("hex").slice(0, 16);
  return { id, source, key };
}

function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
