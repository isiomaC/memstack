import type { MemStackConfig } from "@memstack/core";
import { loadConfigFromEnv } from "@memstack/config-env";

export async function loadConfig(): Promise<MemStackConfig> {
  const { config } = await loadConfigFromEnv();
  return config;
}
