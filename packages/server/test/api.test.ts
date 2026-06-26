import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";

const bunAvailable = (() => {
  try { execSync("bun --version", { stdio: "ignore" }); return true; }
  catch { return false; }
})();

async function fetchAPI(path: string, opts?: RequestInit) {
  const res = await fetch(`http://localhost:5567${path}`, opts);
  const body = await res.json();
  return { status: res.status, body };
}

describe("Server HTTP integration", () => {
  let serverPID: number;

  beforeAll(async () => {
    if (!bunAvailable) return;
    const { spawn } = await import("node:child_process");
    const child = spawn("bun", ["run", "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        PORT: "5567",
        MEMSTACK_STORAGE: "memory",
        MEMSTACK_EMBED_ON_STORE: "false",
        OPENAI_API_KEY: "sk-test",
      },
      stdio: "ignore",
    });
    serverPID = child.pid!;
    await new Promise((r) => setTimeout(r, 2000));
  });

  afterAll(() => {
    if (!serverPID) return;
    process.kill(serverPID, "SIGTERM");
  });

  it("GET /health returns ok", async () => {
    if (!bunAvailable) return;
    const { status, body } = await fetchAPI("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("POST /v1/memories stores and returns 201", async () => {
    if (!bunAvailable) return;
    const { status, body } = await fetchAPI("/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", content: "hello", importance: 0.8 }),
    });
    expect(status).toBe(201);
    expect(body.id).toMatch(/^mem_/);
  });

  it("GET /v1/memories/:id returns stored memory", async () => {
    if (!bunAvailable) return;
    const { body: created } = await fetchAPI("/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", content: "find me" }),
    });
    const { status, body } = await fetchAPI(`/v1/memories/${created.id}`);
    expect(status).toBe(200);
    expect(body.content).toBe("find me");
  });

  it("GET /v1/memories/:id returns 404 for missing", async () => {
    if (!bunAvailable) return;
    const { status } = await fetchAPI("/v1/memories/nonexistent");
    expect(status).toBe(404);
  });

  it("DELETE /v1/memories/:id deletes and returns true", async () => {
    if (!bunAvailable) return;
    const { body: created } = await fetchAPI("/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", content: "delete me" }),
    });
    const { status, body } = await fetchAPI(`/v1/memories/${created.id}`, { method: "DELETE" });
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
  });

  it("POST /v1/memories/retrieve returns memories", async () => {
    if (!bunAvailable) return;
    await fetchAPI("/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", content: "retrieve me" }),
    });
    const { status, body } = await fetchAPI("/v1/memories/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test" }),
    });
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /v1/memories/context compiles context", async () => {
    if (!bunAvailable) return;
    const { status, body } = await fetchAPI("/v1/memories/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", maxTokens: 500 }),
    });
    expect(status).toBe(200);
    expect(body.context).toBeDefined();
  });

  it("POST /v1/memories/process creates memory", async () => {
    if (!bunAvailable) return;
    const { status, body } = await fetchAPI("/v1/memories/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", content: "process test" }),
    });
    expect(status).toBe(201);
    expect(body.memory.id).toMatch(/^mem_/);
  });

  it("GET /v1/memories/count returns count", async () => {
    if (!bunAvailable) return;
    const { status, body } = await fetchAPI("/v1/memories/count?actorId=test");
    expect(status).toBe(200);
    expect(body.count).toBeGreaterThanOrEqual(0);
  });

  it("POST /v1/memories/:id/touch bumps recency", async () => {
    if (!bunAvailable) return;
    const { body: created } = await fetchAPI("/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", content: "touch me" }),
    });
    const { status, body } = await fetchAPI(`/v1/memories/${created.id}/touch`, { method: "POST" });
    expect(status).toBe(200);
    expect(body.touched).toBe(true);
  });

  it("POST /v1/memories/delete-many deletes multiple", async () => {
    if (!bunAvailable) return;
    const { body: c1 } = await fetchAPI("/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", content: "del1" }),
    });
    const { body: c2 } = await fetchAPI("/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "test", content: "del2" }),
    });
    const { status, body } = await fetchAPI("/v1/memories/delete-many", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [c1.id, c2.id] }),
    });
    expect(status).toBe(200);
    expect(body.deleted).toBe(2);
  });

  it("GET /v1/stats/:actorId returns stats", async () => {
    if (!bunAvailable) return;
    const { status } = await fetchAPI("/v1/stats/test");
    expect(status).toBe(200);
  });
});
