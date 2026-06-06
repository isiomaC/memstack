import type { Memory, CompiledContext } from "../types.js";
import type { ContextOptions } from "../interfaces.js";

export class ContextCompiler {
  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  compile(memories: Memory[], options: ContextOptions): CompiledContext {
    const relevant = memories.filter((m) => {
      if (options.memoryTypes && options.memoryTypes.length > 0) {
        return options.memoryTypes.includes(m.memoryType);
      }
      return true;
    });

    // Recent: last 10, sorted by date
    const recentMemories = [...relevant]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 10);

    // Important: top 10 by importance, deduplicated by content similarity
    const importantMemories = this.deduplicate(
      [...relevant]
        .filter((m) => !recentMemories.find((r) => r.id === m.id))
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 10)
    );

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(recentMemories, importantMemories, options);

    // Token estimate
    const allContent = recentMemories
      .concat(importantMemories)
      .map((m) => m.content)
      .join("\n");
    const tokenEstimate = this.estimateTokens(systemPrompt + allContent);

    return {
      systemPrompt,
      recentMemories,
      importantMemories,
      tokenEstimate,
    };
  }

  private buildSystemPrompt(
    recent: Memory[],
    important: Memory[],
    options: ContextOptions
  ): string {
    const parts: string[] = [];

    if (important.length > 0) {
      parts.push("## Important Memories");
      for (const m of important) {
        parts.push(`- ${m.content} (${m.memoryType}, importance: ${m.importance.toFixed(2)})`);
      }
    }

    if (recent.length > 0) {
      parts.push("\n## Recent Interactions");
      for (const m of recent) {
        parts.push(`- ${m.content}`);
      }
    }

    return parts.join("\n");
  }

  private deduplicate(memories: Memory[]): Memory[] {
    const seen = new Set<string>();
    const result: Memory[] = [];
    for (const m of memories) {
      const key = m.content.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(m);
      }
    }
    return result;
  }
}
