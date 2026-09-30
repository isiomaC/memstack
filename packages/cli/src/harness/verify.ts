// Starts the MCP server as a harness would and checks it answers: the MCP
// handshake, the five harness tools, and a storage round trip.
import { spawn } from "node:child_process";
import type { ServerLaunch } from "./types.js";

export const HARNESS_TOOLS = ["memory_store", "memory_retrieve", "memory_get", "memory_delete", "memory_stats"];

export interface VerifyResult {
  ok: boolean;
  /** memory_stats output, e.g. "Project abc (/repo): 3 memories. Global: 1." */
  stats?: string;
  error?: string;
}

export type Verifier = (launch: ServerLaunch, options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<VerifyResult>;

export const verifyServer: Verifier = (launch, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();

    const finish = (result: VerifyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `No response within 20 s. ${lastLine(stderr)}`.trim() }), 20_000);

    child.on("error", (error) => finish({ ok: false, error: `Could not start ${launch.command}: ${error.message}` }));
    child.on("exit", (code) => finish({ ok: false, error: `Server exited with code ${code}. ${lastLine(stderr)}`.trim() }));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          pending.get(message.id)?.(message);
        } catch {
          // Not JSON-RPC; ignore.
        }
      }
    });

    let nextId = 1;
    const request = (method: string, params: unknown) =>
      new Promise<{ result?: unknown; error?: { message: string } }>((reply) => {
        const id = nextId++;
        pending.set(id, reply);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    void (async () => {
      const init = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "memstack-connect", version: "1" },
      });
      if (init.error) return finish({ ok: false, error: init.error.message });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const list = await request("tools/list", {});
      const names = ((list.result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name);
      const missing = HARNESS_TOOLS.filter((t) => !names.includes(t));
      if (missing.length > 0) return finish({ ok: false, error: `Server is missing harness tools: ${missing.join(", ")}` });

      const stats = await request("tools/call", { name: "memory_stats", arguments: {} });
      const result = stats.result as { content?: { text: string }[]; isError?: boolean } | undefined;
      const text = result?.content?.map((c) => c.text).join("\n") ?? stats.error?.message ?? "";
      if (!result || result.isError) return finish({ ok: false, error: text || "memory_stats failed" });
      finish({ ok: true, stats: text });
    })();
  });

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).pop() ?? "";
}
