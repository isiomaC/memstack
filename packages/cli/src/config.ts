import type { MemStackConfig } from "@memstack/core";
import { loadConfig as loadConfigFile } from "@memstack/config-env";

/** ~/.memstack/config.json overlaid with environment variables, as the harness commands use. */
export async function loadConfig(): Promise<MemStackConfig> {
  const { config } = await loadConfigFile();
  return config;
}
