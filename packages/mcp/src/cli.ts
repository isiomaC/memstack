#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  const { config, defaultActorId } = await loadConfig();
  const server = createServer({ config, defaultActorId });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
