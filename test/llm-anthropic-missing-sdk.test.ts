import { describe, it, expect } from "vitest";
import { AnthropicLLMAdapter } from "../src/adapters/llm/anthropic.js";

// Deliberately does NOT mock "@anthropic-ai/sdk" — it's an optional peer
// dependency that is genuinely not installed in this repo, so this exercises
// the real dynamic-import failure path the same way an end user hits it if
// they configure ANTHROPIC_API_KEY without running
// `npm install @anthropic-ai/sdk`.
describe("AnthropicLLMAdapter — missing @anthropic-ai/sdk", () => {
  it("throws an actionable, non-retryable error instead of a raw module-not-found stack trace", async () => {
    const adapter = new AnthropicLLMAdapter({ apiKey: "sk-ant-test" });

    await expect(adapter.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      code: "LLM_ERROR",
      retryable: false,
      message: expect.stringContaining("npm install @anthropic-ai/sdk"),
    });
  });
});
