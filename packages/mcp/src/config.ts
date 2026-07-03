import type { MemStackConfig } from "@memstack/core";
import { loadConfigFromEnv } from "@memstack/config-env";

export async function loadConfig(): Promise<{ config: MemStackConfig; defaultActorId: string }> {
  return loadConfigFromEnv();
}
