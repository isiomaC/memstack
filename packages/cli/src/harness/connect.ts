import { join } from "node:path";
import { memstackHome } from "@memstack/config-env";
import { run, type Runner } from "./exec.js";
import { readBlock, removeBlock, renderBlock, upsertBlock } from "./instructions.js";
import { verifyServer, type Verifier, type VerifyResult } from "./verify.js";
import { sameLaunch, type CommandStep, type ConnectPlan, type HarnessAdapter, type ServerLaunch } from "./types.js";

export interface ConnectOptions {
  adapter: HarnessAdapter;
  launch: ServerLaunch;
  runner?: Runner;
  verify?: Verifier;
  /** Plan and verify, but change nothing. */
  dryRun?: boolean;
  /** Add MemStack guidance to the harness's instruction file, when it has one. Default true. */
  instructions?: boolean;
  /** Where instruction files are backed up before a change. Default ~/.memstack/backups. */
  backupDir?: string;
}

export interface ConnectResult {
  plan: ConnectPlan;
  /** Config was changed. False when already connected or on a dry run. */
  changed: boolean;
  verification: VerifyResult;
}

/**
 * Registers MemStack with a harness. The server is started and checked
 * before any config changes, so a broken install never gets registered.
 * After the change the harness's own config is read back to confirm it,
 * and any failure part-way restores the previous entry. Running it again
 * with the same launch changes nothing.
 */
export async function connectHarness({
  adapter,
  launch,
  runner = run,
  verify = verifyServer,
  dryRun,
  instructions = true,
  backupDir = join(memstackHome(), "backups"),
}: ConnectOptions): Promise<ConnectResult> {
  const state = await adapter.inspect();
  if (!state.installed) throw new Error(`${adapter.displayName} is not installed: \`${adapter.binary}\` is not on PATH.`);

  const alreadyConnected = sameLaunch(state.entry, launch);
  const plan: ConnectPlan = {
    harness: adapter.id,
    previous: state.entry,
    target: launch,
    steps: alreadyConnected ? [] : [...(state.entry ? adapter.removeSteps() : []), ...adapter.addSteps(launch)],
  };
  const block = adapter.instructions && instructions ? renderBlock(adapter.instructions.body, adapter.id) : undefined;
  if (adapter.instructions && block) {
    const current = readBlock(adapter.instructions.path);
    plan.instructions = { path: adapter.instructions.path, change: current === null ? "add" : current === block ? "none" : "update" };
  }

  const verification = await verify(launch);
  if (!verification.ok) {
    throw new Error(`MemStack's MCP server did not start correctly, so ${adapter.displayName} was not changed: ${verification.error}`);
  }
  if (dryRun) return { plan, changed: false, verification };

  let changed = false;
  if (!alreadyConnected) {
    await applyWithRollback(adapter, plan, runner);
    changed = true;
  }
  if (block && plan.instructions && plan.instructions.change !== "none") {
    try {
      upsertBlock(plan.instructions.path, block, backupDir);
      changed = true;
    } catch (error) {
      const restored = alreadyConnected || (await restore(adapter, plan.previous, runner));
      throw new Error(
        `Could not update ${plan.instructions.path}: ${(error as Error).message}. ${restored ? "The previous configuration was restored." : "Restoring the previous configuration failed; run `memstack doctor`."}`,
      );
    }
  }
  return { plan, changed, verification };
}

/** Removes MemStack from a harness. Does nothing when it is not registered. */
export async function disconnectHarness({
  adapter,
  runner = run,
  dryRun,
  backupDir = join(memstackHome(), "backups"),
}: Omit<ConnectOptions, "launch" | "verify" | "instructions">): Promise<{ plan: ConnectPlan; changed: boolean }> {
  const state = await adapter.inspect();
  if (!state.installed) throw new Error(`${adapter.displayName} is not installed: \`${adapter.binary}\` is not on PATH.`);
  const plan: ConnectPlan = { harness: adapter.id, previous: state.entry, steps: state.entry ? adapter.removeSteps() : [] };
  if (adapter.instructions) {
    plan.instructions = { path: adapter.instructions.path, change: readBlock(adapter.instructions.path) === null ? "none" : "remove" };
  }
  if (dryRun) return { plan, changed: false };

  let changed = false;
  if (plan.steps.length > 0) {
    await applyWithRollback(adapter, plan, runner);
    changed = true;
  }
  if (plan.instructions?.change === "remove") changed = removeBlock(plan.instructions.path, backupDir) || changed;
  return { plan, changed };
}

async function applyWithRollback(adapter: HarnessAdapter, plan: ConnectPlan, runner: Runner): Promise<void> {
  try {
    for (const step of plan.steps) await runStep(step, runner);
    const after = await adapter.inspect();
    if (!sameLaunch(after.entry, plan.target)) {
      throw new Error(`${adapter.displayName} does not show the expected MemStack entry after the change.`);
    }
  } catch (error) {
    const restored = await restore(adapter, plan.previous, runner);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} ${restored ? "The previous configuration was restored." : "Restoring the previous configuration failed; run `memstack doctor`."}`);
  }
}

async function restore(adapter: HarnessAdapter, previous: ServerLaunch | undefined, runner: Runner): Promise<boolean> {
  try {
    const current = await adapter.inspect();
    if (sameLaunch(current.entry, previous)) return true;
    if (current.entry) for (const step of adapter.removeSteps()) await runStep(step, runner);
    if (previous) for (const step of adapter.addSteps(previous)) await runStep(step, runner);
    return sameLaunch((await adapter.inspect()).entry, previous);
  } catch {
    return false;
  }
}

async function runStep(step: CommandStep, runner: Runner): Promise<void> {
  const result = await runner(step.command, step.args);
  if (result.code !== 0) {
    throw new Error(`\`${step.command} ${step.args.slice(0, 3).join(" ")}\` failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

/** A step as a shell-like line for previews; JSON arguments are shown quoted. */
export function describeStep(step: CommandStep): string {
  return [step.command, ...step.args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))].join(" ");
}
