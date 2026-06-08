import type { Memory, CompiledContext } from "../types.js";
import type { ContextOptions } from "../interfaces.js";

export class ContextCompiler {
  /**
   * Estimate token count from text using a blended heuristic.
   * Combines word-based (prose) and character-based (code/json) estimates,
   * taking the max to handle arbitrary content types.
   */
  private estimateTokens(text: string): number {
    const charEst = Math.ceil(text.length / 4);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const wordEst = Math.ceil(words.length * 1.3);
    return Math.max(charEst, Math.max(1, wordEst));
  }

  /**
   * Truncate text to fit within a token budget, preserving whole words.
   * Appends "..." when content is cut. Falls back to character-based
   * truncation for text with few/no word boundaries.
   */
  private truncateToTokens(text: string, maxTokens: number): string {
    if (this.estimateTokens(text) <= maxTokens) return text;

    const words = text.split(/\s+/);
    const targetWords = Math.max(1, Math.floor(maxTokens / 1.3));
    let currentTokens = 0;
    let i = 0;
    for (; i < words.length && i < targetWords; i++) {
      currentTokens += this.estimateTokens(words[i]);
      if (currentTokens > maxTokens) break;
    }
    if (i >= words.length) return text;
    if (i > 0) return words.slice(0, i).join(" ") + "...";

    // Single long word (e.g., JSON): fall back to character-based cut
    const charLimit = maxTokens * 4;
    return text.slice(0, charLimit) + "...";
  }

  compile(memories: Memory[], options: ContextOptions): CompiledContext {
    const maxTokens = options.maxTokens ?? 2000;

    const relevant = memories.filter((m) => {
      if (options.memoryTypes && options.memoryTypes.length > 0) {
        return options.memoryTypes.includes(m.memoryType);
      }
      return true;
    });

    const sortedRecent = [...relevant].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    const sortedImportant = this.deduplicate(
      [...relevant]
        .filter((m) => m.importance >= 0.5)
        .sort((a, b) => b.importance - a.importance)
    );

    const { recentMemories, importantMemories, systemPrompt } =
      this.assembleTokenBudgeted(sortedRecent, sortedImportant, maxTokens);

    const tokenEstimate = this.estimateTokens(systemPrompt);

    return { systemPrompt, recentMemories, importantMemories, tokenEstimate };
  }

  private assembleTokenBudgeted(
    recent: Memory[],
    important: Memory[],
    maxTokens: number
  ): { recentMemories: Memory[]; importantMemories: Memory[]; systemPrompt: string } {
    const includedImportant: Memory[] = [];
    const includedRecent: Memory[] = [];
    const seen = new Set<string>();
    let usedTokens = 0;

    // Add important memories first (signal over recency)
    for (const m of important) {
      if (seen.has(m.id)) continue;
      const prefix = `- `;
      const suffix = ` (${m.memoryType}, importance: ${m.importance.toFixed(2)})\n`;
      const overhead = this.estimateTokens(prefix + suffix);
      let tokens = this.estimateTokens(m.content) + overhead;
      const remaining = Math.floor(maxTokens * 0.6) - usedTokens;
      if (remaining <= 0) break;
      if (tokens > remaining) {
        const contentBudget = Math.max(0, remaining - overhead);
        if (contentBudget > 0) {
          const truncatedContent = this.truncateToTokens(m.content, contentBudget);
          includedImportant.push({ ...m, content: truncatedContent });
          tokens = this.estimateTokens(truncatedContent) + overhead;
          usedTokens += tokens;
          seen.add(m.id);
        }
      } else {
        includedImportant.push(m);
        usedTokens += tokens;
        seen.add(m.id);
      }
    }

    // Add recent memories until budget is full
    for (const m of recent) {
      if (seen.has(m.id)) continue;
      const prefix = `- `;
      const suffix = `\n`;
      const overhead = this.estimateTokens(prefix + suffix);
      let tokens = this.estimateTokens(m.content) + overhead;
      const remaining = maxTokens - usedTokens;
      if (remaining <= 0) break;
      if (tokens > remaining) {
        const contentBudget = Math.max(0, remaining - overhead);
        if (contentBudget > 0) {
          const truncatedContent = this.truncateToTokens(m.content, contentBudget);
          includedRecent.push({ ...m, content: truncatedContent });
          tokens = this.estimateTokens(truncatedContent) + overhead;
          usedTokens += tokens;
          seen.add(m.id);
        }
      } else {
        includedRecent.push(m);
        usedTokens += tokens;
        seen.add(m.id);
      }
    }

    const parts: string[] = [];
    if (includedImportant.length > 0) {
      parts.push("## Important Memories");
      for (const m of includedImportant) {
        parts.push(`- ${m.content} (${m.memoryType}, importance: ${m.importance.toFixed(2)})`);
      }
    }
    if (includedRecent.length > 0) {
      parts.push("\n## Recent Interactions");
      for (const m of includedRecent) {
        parts.push(`- ${m.content}`);
      }
    }

    return { recentMemories: includedRecent, importantMemories: includedImportant, systemPrompt: parts.join("\n") };
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
