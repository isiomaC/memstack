#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createServer as createHttpServer } from "node:http";
import { HarnessMemory, InMemoryStorageAdapter, MemStack } from "@memstack/core";
import type { MemStackConfig, SecretPolicy } from "@memstack/core";
import { resolveProject } from "@memstack/config-env";
import { loadConfig, loadHarnessConfig } from "./config.js";
import { createServer } from "./server.js";
import { createHarnessServer } from "./harness.js";
import { runSessionStartHook } from "./hook.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

async function main() {
  // `memstack-mcp hook session-start`: harness hook, not an MCP server.
  if (process.argv[2] === "hook") {
    if (process.argv[3] !== "session-start") {
      console.error(`Unknown hook "${process.argv[3] ?? ""}". Supported: session-start`);
      return;
    }
    await runSessionStartHook();
    process.exit(0);
  }

  const { values } = parseArgs({
    options: {
      http: { type: "boolean", default: false },
      port: { type: "string", default: "3939" },
      host: { type: "string", default: "127.0.0.1" },
      profile: { type: "string", default: "default" },
      harness: { type: "string" },
    },
  });

  if (values.profile === "harness") {
    if (values.http) throw new Error("--profile harness supports stdio only: the project comes from the harness's working directory");
    await runHarness(values.harness);
    return;
  }
  if (values.profile !== "default") throw new Error(`Unknown --profile "${values.profile}". Use "default" or "harness".`);

  const { config, defaultActorId } = await loadConfig();

  if (values.http) {
    await runHttp({ config, defaultActorId, port: Number(values.port), host: values.host });
    return;
  }

  const ms = new MemStack(config);
  const server = createServer({ config, defaultActorId, ms });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  exitWhenStdinCloses(transport, () => ms.close());
}

/**
 * Harness profile over stdio. Claude Code sets CLAUDE_PROJECT_DIR; Codex
 * starts the server in the session's working directory. Either way the
 * project is resolved once, at startup.
 */
async function runHarness(harness: string | undefined) {
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const project = resolveProject(cwd);
  const { config } = await loadHarnessConfig();
  const storage = config.storage ?? new InMemoryStorageAdapter();
  if (storage instanceof InMemoryStorageAdapter) {
    console.error("memstack-mcp: storage is in-memory, so memories are lost when this session ends. Run `memstack init` to choose a store.");
  }

  const memory = new HarnessMemory({
    storage,
    llm: config.llm,
    secretPolicy: secretPolicyFromEnv(),
    onError: (error, context) => console.error(`memstack-mcp: ${context}: ${error.message}`),
  });
  const adopted = await memory.adoptProjects(project.previousIds, project.id);
  if (adopted > 0) console.error(`memstack-mcp: moved ${adopted} memories from this project's previous ID to ${project.id}.`);
  const server = createHarnessServer({ memory, projectId: project.id, harness, cwd: project.root });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  exitWhenStdinCloses(transport, () => storage.close());
}

/**
 * Exit once the client closes stdin and every in-flight request has been
 * answered. Open storage connections (e.g. a Postgres pool) would otherwise
 * keep the process alive after the client has gone.
 */
function exitWhenStdinCloses(transport: StdioServerTransport, close: () => Promise<void>) {
  let pending = 0;
  let ended = false;
  const finish = () => {
    if (ended && pending === 0) void close().finally(() => process.exit(0));
  };

  const onmessage = transport.onmessage;
  transport.onmessage = (message: JSONRPCMessage) => {
    if ("method" in message && "id" in message) pending++;
    onmessage?.(message);
  };

  const send = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage) => {
    await send(message);
    if (!("method" in message) && "id" in message) {
      pending--;
      finish();
    }
  };

  process.stdin.once("end", () => {
    ended = true;
    finish();
  });
}

/**
 * Stateless Streamable HTTP mode: one shared MemStack instance (so storage
 * connections aren't re-opened per request) but a fresh MCP protocol Server +
 * transport per request, since a Server only supports one active transport.
 */
async function runHttp({ config, defaultActorId, port, host }: { config: MemStackConfig; defaultActorId: string; port: number; host: string }) {
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

  httpServer.listen(port, host, () => {
    console.error(`memstack-mcp listening on http://${host.includes(":") ? `[${host}]` : host}:${port}/mcp (Streamable HTTP, stateless)`);
    if (!isLoopback(host)) {
      console.error(`memstack-mcp: warning: ${host} is reachable from other machines and this server has no authentication. Anyone who can connect can read and write memory. Put it behind a proxy that authenticates, or use 127.0.0.1.`);
    }
  });
}

/** MEMSTACK_SECRET_POLICY: reject (default), redact, or off. Anything else is a startup error. */
function secretPolicyFromEnv(): SecretPolicy | undefined {
  const value = process.env.MEMSTACK_SECRET_POLICY?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "reject" || value === "redact" || value === "off") return value;
  throw new Error(`MEMSTACK_SECRET_POLICY must be "reject", "redact", or "off", not "${value}"`);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
