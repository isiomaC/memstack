import { run, type Runner } from "./exec.js";
import { verifyServer, type Verifier, type VerifyResult } from "./verify.js";
import { sameLaunch, type CommandStep, type ConnectPlan, type HarnessAdapter, type ServerLaunch } from "./types.js";

export interface ConnectOptions {
  adapter: HarnessAdapter;
  launch: ServerLaunch;
  runner?: Runner;
  verify?: Verifier;
  /** Plan and verify, but change nothing. */
  dryRun?: boolean;
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
export async function connectHarness({ adapter, launch, runner = run, verify = verifyServer, dryRun }: ConnectOptions): Promise<ConnectResult> {
  const state = await adapter.inspect();
  if (!state.installed) throw new Error(`${adapter.displayName} is not installed: \`${adapter.binary}\` is not on PATH.`);

  const alreadyConnected = sameLaunch(state.entry, launch);
  const plan: ConnectPlan = {
    harness: adapter.id,
    previous: state.entry,
    target: launch,
    steps: alreadyConnected ? [] : [...(state.entry ? adapter.removeSteps() : []), ...adapter.addSteps(launch)],
  };

  const verification = await verify(launch);
  if (!verification.ok) {
    throw new Error(`MemStack's MCP server did not start correctly, so ${adapter.displayName} was not changed: ${verification.error}`);
  }
  if (dryRun || alreadyConnected) return { plan, changed: false, verification };

  await applyWithRollback(adapter, plan, runner);
  return { plan, changed: true, verification };
}

/** Removes MemStack from a harness. Does nothing when it is not registered. */
export async function disconnectHarness({ adapter, runner = run, dryRun }: Omit<ConnectOptions, "launch" | "verify">): Promise<{ plan: ConnectPlan; changed: boolean }> {
  const state = await adapter.inspect();
  if (!state.installed) throw new Error(`${adapter.displayName} is not installed: \`${adapter.binary}\` is not on PATH.`);
  const plan: ConnectPlan = { harness: adapter.id, previous: state.entry, steps: state.entry ? adapter.removeSteps() : [] };
  if (dryRun || plan.steps.length === 0) return { plan, changed: false };
  await applyWithRollback(adapter, plan, runner);
  return { plan, changed: true };
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
