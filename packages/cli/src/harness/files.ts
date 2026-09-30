// Small file helpers shared by the instruction-block and hook editors.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Writes content atomically, keeping an existing file's mode. `null` deletes the file. */
export function writeFileAtomic(path: string, content: string | null): void {
  if (content === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const tmp = `${path}.memstack-${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

/** Copies a file into `backupDir` with a timestamp suffix. */
export function backupFile(path: string, backupDir: string): void {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  copyFileSync(path, join(backupDir, `${basename(path)}.${new Date().toISOString().replace(/[:.]/g, "-")}`));
}

/** The file's content, or null when it does not exist; used to undo a change exactly. */
export function snapshot(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
