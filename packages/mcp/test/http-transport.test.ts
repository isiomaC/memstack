import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";

const distEntry = new URL("../dist/cli.js", import.meta.url).pathname;
const distAvailable = existsSync(distEntry);

// Runs the built dist/cli.js in --http mode to confirm the Streamable HTTP
// transport actually serves MCP protocol requests, not just typechecks.
describe("MCP Streamable HTTP transport", () => {
  let serverPID: number;

  beforeAll(async () => {
    if (!distAvailable) return;
    const { spawn } = await import("node:child_process");
    const child = spawn("node", ["dist/cli.js", "--http", "--port", "5702"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, MEMSTACK_STORAGE: "memory", OPENAI_API_KEY: "sk-test" },
      stdio: "ignore",
    });
    serverPID = child.pid!;
    // Poll until the server accepts connections (robust under parallel-suite
    // CPU contention where a fixed sleep can lose the startup race).
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        await fetch("http://localhost:5702/nonexistent");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }, 20000);

  afterAll(() => {
    if (!serverPID) return;
    process.kill(serverPID, "SIGTERM");
  });

  it("responds to an initialize request over POST /mcp", async () => {
    if (!distAvailable) return;
    const res = await fetch("http://localhost:5702/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"serverInfo"');
    expect(text).toContain('"name":"memstack"');
  });

  it("rejects GET /mcp with 405", async () => {
    if (!distAvailable) return;
    const res = await fetch("http://localhost:5702/mcp");
    expect(res.status).toBe(405);
  });

  it("returns 404 for unknown paths", async () => {
    if (!distAvailable) return;
    const res = await fetch("http://localhost:5702/nonexistent");
    expect(res.status).toBe(404);
  });
});
