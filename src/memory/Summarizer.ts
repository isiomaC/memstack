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

    const chunkSize = options.chunkSize ?? 50;
    if (memories.length > chunkSize) {
      return this._summarizeChunked(memories, options, promptOverride);
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
      throw new MemStackError(
        "LLM_ERROR",
        `Summarization failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true, details: { cause: err instanceof Error ? err.message : String(err) } }
      );
    }
  }

  private async _summarizeChunked(
    memories: Memory[],
    options: SummarizeOptions,
    promptOverride?: string
  ): Promise<{ summaryContent: string; tokenCount: number }> {
    const chunkSize = options.chunkSize ?? 50;
    const sorted = [...memories].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const chunks: Memory[][] = [];
    for (let i = 0; i < sorted.length; i += chunkSize) {
      chunks.push(sorted.slice(i, i + chunkSize));
    }

    let totalTokens = 0;

    const chunkSummaries: string[] = [];
    for (const chunk of chunks) {
      const memoryTexts = chunk.map((m) => `[${m.createdAt.toISOString()}] ${m.content}`);
      const system = promptOverride ?? this.defaultPrompt;
      const user = memoryTexts.join("\n\n");

      try {
        const response = await this.llm.complete({ system, user });
        chunkSummaries.push(response.text.trim());
        totalTokens += response.tokens.total;
      } catch (err) {
        if (err instanceof MemStackError) throw err;
        throw new MemStackError(
          "LLM_ERROR",
          `Chunked summarization failed: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true, details: { cause: err instanceof Error ? err.message : String(err) } }
        );
      }
    }

    if (chunkSummaries.length === 1) {
      return { summaryContent: chunkSummaries[0], tokenCount: totalTokens };
    }

    const summaryMemories: Memory[] = chunkSummaries.map((content, i) => ({
      id: `_chunk_summary_${i}`,
      actorId: sorted[0].actorId,
      memoryType: "summary" as const,
      content,
      importance: 0.5,
      emotionalValence: 0,
      tags: ["summary"],
      createdAt: sorted[sorted.length - 1].createdAt,
    }));

    const merged = await this._summarizeChunked(summaryMemories, options, promptOverride);
    return {
      summaryContent: merged.summaryContent,
      tokenCount: totalTokens + merged.tokenCount,
    };
  }

  async *summarizeStream(
    memories: Memory[],
    options: SummarizeOptions = {},
    promptOverride?: string
  ): AsyncIterable<{ chunk: string; text: string }> {
    if (memories.length === 0) {
      throw new MemStackError("VALIDATION_ERROR", "No memories to summarize");
    }
    if (!this.llm.completeStream) {
      const result = await this.summarize(memories, options, promptOverride);
      yield { chunk: result.summaryContent, text: result.summaryContent };
      return;
    }

    const chunkSize = options.chunkSize ?? 50;
    let toSummarize = memories;
    if (memories.length > chunkSize) {
      const chunked = await this._summarizeChunked(memories, options, promptOverride);
      toSummarize = [{ id: "_chunked", actorId: "summarizer", memoryType: "summary", content: chunked.summaryContent, importance: 0.5, emotionalValence: 0, tags: [], createdAt: new Date() }];
    }

    const sorted = [...toSummarize].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const memoryTexts = sorted.map((m) => `[${m.createdAt.toISOString()}] ${m.content}`);
    const system = promptOverride ?? this.defaultPrompt;
    const user = memoryTexts.join("\n\n");

    let fullText = "";
    for await (const chunk of this.llm.completeStream({ system, user })) {
      fullText += chunk.text;
      yield { chunk: chunk.text, text: fullText };
    }
  }
}
