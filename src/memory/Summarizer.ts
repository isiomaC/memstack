import type { LLMProvider } from "../interfaces.js";
import type { Memory } from "../types.js";
import type { SummarizeOptions } from "../interfaces.js";
import { MemStackError } from "../errors.js";

export class Summarizer {
  private llm: LLMProvider;
  private defaultPrompt: string;

  constructor(llm: LLMProvider, defaultPrompt?: string) {
    this.llm = llm;
    this.defaultPrompt = defaultPrompt ??
      "You are a memory summarizer. Condense the following list of memories into a single, concise summary paragraph that captures the key events, emotional tone, and important details. Write in third person past tense.";
  }

  async summarize(
    memories: Memory[],
    options: SummarizeOptions = {},
    promptOverride?: string
  ): Promise<{ summaryContent: string; tokenCount: number }> {
    if (memories.length === 0) {
      throw new MemStackError("VALIDATION_ERROR", "No memories to summarize");
    }

    const sorted = [...memories].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const memoryTexts = sorted.map((m) => `[${m.createdAt.toISOString()}] ${m.content}`);

    const system = promptOverride ?? this.defaultPrompt;
    const user = memoryTexts.join("\n\n");

    try {
      const response = await this.llm.complete({ system, user });
      return {
        summaryContent: response.text.trim(),
        tokenCount: response.tokens.total,
      };
    } catch (err) {
      if (err instanceof MemStackError) throw err;
      throw new MemStackError("LLM_ERROR", "Summarization failed", { retryable: true });
    }
  }
}
