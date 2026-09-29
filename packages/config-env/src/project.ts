// Project identity shared by every harness (ADR 0001, D3). Claude Code and
// Codex started anywhere inside the same repository resolve the same ID.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ProjectIdentity {
  /** Short stable hash, used in `project:<id>` namespaces. */
  id: string;
  /** What the ID was derived from. */
  source: "remote" | "git" | "directory";
  /** Normalized remote (`host/owner/repo`), git repository, or directory the ID hashes. */
  key: string;
  /** Git working tree root, or the directory itself outside git. */
  root: string;
}

/**
 * Resolves the project for a working directory, preferring, in order:
 * the normalized `origin` remote (so clones and worktrees share memory),
 * the shared git directory (so worktrees of a local-only repo share memory),
 * and the directory itself.
 */
export function resolveProject(cwd: string = process.cwd()): ProjectIdentity {
  const dir = realpathSync(resolve(cwd));
  const root = git(dir, ["rev-parse", "--show-toplevel"]);

  if (root) {
    const remote = git(root, ["config", "--get", "remote.origin.url"]);
    const normalized = remote ? normalizeRemote(remote) : null;
    if (normalized) return identity("remote", normalized, root);

    const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const repo = commonDir ? dirname(realpathSync(commonDir)) : root;
    return identity("git", repo, root);
  }

  return identity("directory", dir, dir);
}

/**
 * Reduces a git remote URL to `host/path` without protocol, credentials,
 * port, or `.git` suffix, so https, ssh, and scp-style URLs of the same
 * repository match. Returns null for local paths and unparseable values.
 */
export function normalizeRemote(url: string): string | null {
  let value = url.trim();
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

function identity(source: ProjectIdentity["source"], key: string, root: string): ProjectIdentity {
  const id = createHash("sha256").update(`${source}:${key}`).digest("hex").slice(0, 16);
  return { id, source, key, root };
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
