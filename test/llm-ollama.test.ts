import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaLLMAdapter } from "../src/adapters/llm/ollama.js";

describe("OllamaLLMAdapter", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts to /api/chat with no auth header and stream disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: { content: "local llama says hi" },
        prompt_eval_count: 8,
        eval_count: 3,
      }),
    });
    global.fetch = fetchMock as never;

    const adapter = new OllamaLLMAdapter();
    const result = await adapter.complete({ system: "sys", user: "hi" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(body.model).toBe("llama3.2");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(result.text).toBe("local llama says hi");
    expect(result.tokens).toEqual({ prompt: 8, completion: 3, total: 11 });
  });

  it("uses a custom baseURL and model, mapping maxTokens to num_predict", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: "ok" } }),
    });
    global.fetch = fetchMock as never;

    const adapter = new OllamaLLMAdapter({ baseURL: "http://gpu-box:11434", defaultModel: "mistral" });
    await adapter.complete({ system: "s", user: "u", maxTokens: 256, temperature: 0.9 });

    expect(fetchMock).toHaveBeenCalledWith("http://gpu-box:11434/api/chat", expect.anything());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("mistral");
    expect(body.options).toEqual({ temperature: 0.9, num_predict: 256 });
  });

  it("defaults missing eval counts to 0", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: "no counts" } }),
    }) as never;

    const adapter = new OllamaLLMAdapter();
    const result = await adapter.complete({ system: "s", user: "u" });
    expect(result.tokens).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it("throws a retryable MemStackError on 5xx responses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "model not loaded",
    }) as never;

    const adapter = new OllamaLLMAdapter();
    await expect(adapter.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      code: "LLM_ERROR",
      retryable: true,
    });
  });

  it("wraps connection failures (server not running) in a retryable MemStackError", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as never;

    const adapter = new OllamaLLMAdapter();
    await expect(adapter.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      code: "LLM_ERROR",
      retryable: true,
    });
  });
});
