import type { MemStackConfig } from "@memstack/core";
import { loadConfigFromEnv, loadConfig as loadConfigWithFile } from "@memstack/config-env";

export async function loadConfig(): Promise<{ config: MemStackConfig; defaultActorId: string }> {
  return loadConfigFromEnv();
}

/** Config for the harness profile: ~/.memstack/config.json overlaid with environment variables. */
export async function loadHarnessConfig(): Promise<{ config: MemStackConfig; defaultActorId: string; llmConfigured: boolean }> {
  return loadConfigWithFile();
}
