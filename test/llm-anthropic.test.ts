import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnthropicLLMAdapter } from "../src/adapters/llm/anthropic.js";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation((opts: { apiKey: string; baseURL: string }) => ({
    __opts: opts,
    messages: { create: createMock },
  })),
}));

describe("AnthropicLLMAdapter", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("sends system+user messages and parses text/usage from the SDK response", async () => {
    createMock.mockResolvedValue({
      content: [{ text: "hi from claude" }],
      usage: { input_tokens: 10, output_tokens: 6 },
    });

    const adapter = new AnthropicLLMAdapter({ apiKey: "sk-ant-test" });
    const result = await adapter.complete({ system: "sys", user: "hello" });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-5-20250929",
        system: "sys",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 1024,
      }),
    );
    expect(result.text).toBe("hi from claude");
    expect(result.tokens).toEqual({ prompt: 10, completion: 6, total: 16 });
  });

  it("passes through model/maxTokens/temperature overrides", async () => {
    createMock.mockResolvedValue({ content: [{ text: "ok" }] });

    const adapter = new AnthropicLLMAdapter({ apiKey: "sk-ant-test", defaultModel: "claude-haiku" });
    await adapter.complete({ system: "s", user: "u", model: "claude-opus", maxTokens: 200, temperature: 0.5 });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus", max_tokens: 200, temperature: 0.5 }),
    );
  });

  it("omits temperature when not provided", async () => {
    createMock.mockResolvedValue({ content: [{ text: "ok" }] });
    const adapter = new AnthropicLLMAdapter({ apiKey: "sk-ant-test" });
    await adapter.complete({ system: "s", user: "u" });

    expect(createMock.mock.calls[0][0]).not.toHaveProperty("temperature");
  });

  it("defaults missing usage to 0 and handles empty content", async () => {
    createMock.mockResolvedValue({ content: [] });
    const adapter = new AnthropicLLMAdapter({ apiKey: "sk-ant-test" });
    const result = await adapter.complete({ system: "s", user: "u" });

    expect(result.text).toBe("");
    expect(result.tokens).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it("wraps SDK errors in a retryable MemStackError", async () => {
    createMock.mockRejectedValue(new Error("rate limited"));
    const adapter = new AnthropicLLMAdapter({ apiKey: "sk-ant-test" });

    await expect(adapter.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      code: "LLM_ERROR",
      retryable: true,
    });
  });
});
