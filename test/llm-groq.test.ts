import { describe, it, expect, vi, afterEach } from "vitest";
import { GroqLLMAdapter } from "../src/adapters/llm/groq.js";

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

describe("GroqLLMAdapter", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts to the Groq-compatible chat/completions endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "groq says hi" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    });
    global.fetch = fetchMock as never;

    const adapter = new GroqLLMAdapter({ apiKey: "gsk-test" });
    const result = await adapter.complete({ system: "sys", user: "hi" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gsk-test" }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(result.text).toBe("groq says hi");
    expect(result.tokens).toEqual({ prompt: 5, completion: 2, total: 7 });
  });

  it("throws a retryable MemStackError on 5xx", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    }) as never;

    const adapter = new GroqLLMAdapter({ apiKey: "gsk-test" });
    await expect(adapter.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      code: "LLM_ERROR",
      retryable: true,
    });
  });

  it("completeStream yields incremental text and accumulates usage from SSE chunks", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
      `data: [DONE]\n\n`,
    ]);

    global.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream }) as never;

    const adapter = new GroqLLMAdapter({ apiKey: "gsk-test" });
    const chunks: { text: string; tokens: { prompt: number; completion: number; total: number } }[] = [];
    for await (const chunk of adapter.completeStream({ system: "s", user: "u" })) {
      chunks.push(chunk);
    }

    // The final SSE frame carries usage but no content (matches real Groq/OpenAI
    // stream_options.include_usage behavior) — it must still be yielded so
    // callers see accurate final token counts, even though its text is empty.
    expect(chunks.map((c) => c.text)).toEqual(["Hel", "lo", ""]);
    expect(chunks.at(-1)?.tokens).toEqual({ prompt: 3, completion: 2, total: 5 });
  });

  it("completeStream reads usage from x_groq.usage fallback", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }], x_groq: { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } })}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream }) as never;

    const adapter = new GroqLLMAdapter({ apiKey: "gsk-test" });
    const chunks = [];
    for await (const chunk of adapter.completeStream({ system: "s", user: "u" })) chunks.push(chunk);

    expect(chunks[0].tokens).toEqual({ prompt: 1, completion: 1, total: 2 });
  });

  it("completeStream throws when the response is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }) as never;

    const adapter = new GroqLLMAdapter({ apiKey: "gsk-test" });
    await expect(async () => {
      for await (const _ of adapter.completeStream({ system: "s", user: "u" })) {
        // drain
      }
    }).rejects.toMatchObject({ code: "LLM_ERROR", retryable: false });
  });
});
