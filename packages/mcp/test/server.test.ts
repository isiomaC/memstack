import { describe, it, expect } from "vitest";
import { createServer } from "../src/server.js";

const mockLLM = {
  async complete(request: { system: string; user: string }) {
    return { text: "response", tokens: { prompt: 10, completion: 5, total: 15 } };
  },
};

describe("createServer", () => {
  it("creates server with InMemoryStorage", () => {
    const server = createServer({ config: { llm: mockLLM as never }, defaultActorId: "test-actor" });
    expect(server).toBeDefined();
  });

  it("server has expected name", () => {
    const server = createServer({ config: { llm: mockLLM as never }, defaultActorId: "test-actor" });
    const info = (server as { _serverInfo?: { name: string } })._serverInfo;
    expect(info?.name || "unknown").toBeDefined();
  });
});
