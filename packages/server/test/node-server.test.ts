import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";

const distEntry = new URL("../dist/serve.js", import.meta.url).pathname;
const distAvailable = existsSync(distEntry);

async function fetchAPI(path: string, opts?: RequestInit) {
  const res = await fetch(`http://localhost:5568${path}`, opts);
  const body = await res.json();
  return { status: res.status, body };
}

// Runs the built dist/serve.js under plain Node (no Bun) to confirm the
// @hono/node-server entry point actually serves requests, not just typechecks.
describe("Server Node.js entry point", () => {
  let serverPID: number;

  beforeAll(async () => {
    if (!distAvailable) return;
    const { spawn } = await import("node:child_process");
    const child = spawn("node", ["dist/serve.js"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        PORT: "5568",
        MEMSTACK_STORAGE: "memory",
        MEMSTACK_EMBED_ON_STORE: "false",
        OPENAI_API_KEY: "sk-test",
      },
      stdio: "ignore",
    });
    serverPID = child.pid!;
    await new Promise((r) => setTimeout(r, 1500));
  });

  afterAll(() => {
    if (!serverPID) return;
    process.kill(serverPID, "SIGTERM");
  });

  it("GET /health returns ok when run under node dist/serve.js", async () => {
    if (!distAvailable) return;
    const { status, body } = await fetchAPI("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("POST /v1/memories stores and returns 201 when run under node dist/serve.js", async () => {
    if (!distAvailable) return;
    const { status, body } = await fetchAPI("/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", content: "hello from node" }),
    });
    expect(status).toBe(201);
    expect(body.id).toMatch(/^mem_/);
  });
});
