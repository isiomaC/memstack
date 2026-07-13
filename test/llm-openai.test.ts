import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAILLMAdapter } from "../src/adapters/llm/openai.js";
import { MemStackError } from "../src/errors.js";

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

describe("OpenAILLMAdapter", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts chat/completions with system+user messages and auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello there" } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
    });
    global.fetch = fetchMock as never;

    const adapter = new OpenAILLMAdapter({ apiKey: "sk-test" });
    const result = await adapter.complete({ system: "sys", user: "hi" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(body.model).toBe("gpt-4o-mini");

    expect(result.text).toBe("hello there");
    expect(result.tokens).toEqual({ prompt: 12, completion: 4, total: 16 });
  });

  it("uses custom baseURL, model, temperature, and maxTokens overrides", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    global.fetch = fetchMock as never;

    const adapter = new OpenAILLMAdapter({
      apiKey: "sk-test",
      baseURL: "https://proxy.example.com/v1",
      defaultModel: "gpt-4o",
    });
    await adapter.complete({ system: "s", user: "u", temperature: 0.2, maxTokens: 50, model: "gpt-4-turbo" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.example.com/v1/chat/completions",
      expect.anything(),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-4-turbo");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(50);
  });

  it("defaults missing usage fields to 0", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "no usage" } }] }),
    }) as never;

    const adapter = new OpenAILLMAdapter({ apiKey: "sk-test" });
    const result = await adapter.complete({ system: "s", user: "u" });
    expect(result.tokens).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it("throws a retryable MemStackError on 5xx responses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "service unavailable",
    }) as never;

    const adapter = new OpenAILLMAdapter({ apiKey: "sk-test" });
    await expect(adapter.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      code: "LLM_ERROR",
      retryable: true,
    });
  });

  it("throws a non-retryable MemStackError on 4xx responses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid api key",
    }) as never;

    const adapter = new OpenAILLMAdapter({ apiKey: "bad-key" });
    await expect(adapter.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      code: "LLM_ERROR",
      retryable: false,
    });
  });

  it("wraps network failures in a retryable MemStackError", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as never;

    const adapter = new OpenAILLMAdapter({ apiKey: "sk-test" });
    await expect(adapter.complete({ system: "s", user: "u" })).rejects.toBeInstanceOf(MemStackError);
    await expect(adapter.complete({ system: "s", user: "u" })).rejects.toMatchObject({ retryable: true });
  });

  it("completeStream yields incremental text, then a final chunk carrying usage", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream }) as never;

    const adapter = new OpenAILLMAdapter({ apiKey: "sk-test" });
    const chunks: { text: string; tokens: { prompt: number; completion: number; total: number } }[] = [];
    for await (const chunk of adapter.completeStream({ system: "s", user: "u" })) chunks.push(chunk);

    expect(chunks.map((c) => c.text)).toEqual(["Hel", "lo", ""]);
    expect(chunks.at(-1)?.tokens).toEqual({ prompt: 3, completion: 2, total: 5 });
  });

  it("completeStream throws when the response is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    }) as never;

    const adapter = new OpenAILLMAdapter({ apiKey: "sk-test" });
    await expect(async () => {
      for await (const _ of adapter.completeStream({ system: "s", user: "u" })) {
        // drain
      }
    }).rejects.toMatchObject({ code: "LLM_ERROR", retryable: true });
  });
});
