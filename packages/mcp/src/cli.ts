#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createServer as createHttpServer } from "node:http";
import { MemStack } from "@memstack/core";
import type { MemStackConfig } from "@memstack/core";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

async function main() {
  const { values } = parseArgs({
    options: {
      http: { type: "boolean", default: false },
      port: { type: "string", default: "3939" },
    },
  });

  const { config, defaultActorId } = await loadConfig();

  if (values.http) {
    await runHttp({ config, defaultActorId, port: Number(values.port) });
    return;
  }

  const server = createServer({ config, defaultActorId });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Stateless Streamable HTTP mode: one shared MemStack instance (so storage
 * connections aren't re-opened per request) but a fresh MCP protocol Server +
 * transport per request, since a Server only supports one active transport.
 */
async function runHttp({ config, defaultActorId, port }: { config: MemStackConfig; defaultActorId: string; port: number }) {
  const ms = new MemStack(config);

  const httpServer = createHttpServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
      );
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf-8");
    const body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;

    const server = createServer({ config, defaultActorId, ms });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }),
        );
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`memstack-mcp listening on http://localhost:${port}/mcp (Streamable HTTP, stateless)`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
