import type { MemStackConfig } from "@memstack/core";
import { loadConfig as loadConfigFile } from "@memstack/config-env";

/**
 * ~/.memstack/config.json overlaid with environment variables, as the harness
 * commands use. For the memory commands (`store`, `retrieve`, ...), which call
 * the LLM, so a key is required here even though the harness works without one.
 */
export async function loadConfig(): Promise<MemStackConfig> {
  const { config, llmConfigured } = await loadConfigFile();
  if (!llmConfigured) throw new Error("At least one of OPENAI_API_KEY or ANTHROPIC_API_KEY must be set, or run `memstack init` to add a key");
  return config;
}
