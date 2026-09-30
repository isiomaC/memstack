import { execFile } from "node:child_process";

export interface RunResult {
  /** Exit code; 127 when the command was not found. */
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[]) => Promise<RunResult>;

/** Runs commands without a shell, so arguments are never interpreted. */
export const createRunner = (env: NodeJS.ProcessEnv = process.env): Runner => (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr: stderr || error.message });
    });
  });

export const run: Runner = createRunner();
