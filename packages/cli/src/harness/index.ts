import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import type { HarnessAdapter, HarnessId } from "./types.js";

export const HARNESS_IDS: HarnessId[] = ["claude-code", "codex"];

export function harnessAdapter(id: string, options: { env?: NodeJS.ProcessEnv } = {}): HarnessAdapter {
  if (id === "claude-code") return claudeCodeAdapter(options);
  if (id === "codex") return codexAdapter(options);
  throw new Error(`Unknown harness "${id}". Supported: ${HARNESS_IDS.join(", ")}.`);
}

export * from "./types.js";
export { connectHarness, disconnectHarness, describeStep } from "./connect.js";
export { createRunner, run } from "./exec.js";
export { verifyServer } from "./verify.js";
export { findMemstackMcp, canResolveFrom, harnessLaunch, installCommand, STORAGE_DRIVERS } from "./locate.js";
