import type { Memory, CompiledContext } from "../types.js";
import type { ContextOptions } from "../interfaces.js";

export class ContextCompiler {
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  compile(memories: Memory[], options: ContextOptions): CompiledContext {
    const maxTokens = options.maxTokens ?? 2000;

    const relevant = memories.filter((m) => {
      if (options.memoryTypes && options.memoryTypes.length > 0) {
        return options.memoryTypes.includes(m.memoryType);
      }
      return true;
    });

    // Recent: sorted newest-first
    const sortedRecent = [...relevant].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    // Important: only high-importance (>=0.5), deduplicated, sorted by importance
    const sortedImportant = this.deduplicate(
      [...relevant]
        .filter((m) => m.importance >= 0.5)
        .sort((a, b) => b.importance - a.importance)
    );

    // Build token-budgeted sections
    const { recentMemories, importantMemories, systemPrompt } =
      this.assembleTokenBudgeted(sortedRecent, sortedImportant, maxTokens);

    const allContent = recentMemories
      .concat(importantMemories)
      .map((m) => m.content)
      .join("\n");
    const tokenEstimate = this.estimateTokens(systemPrompt + allContent);

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
      const line = `- ${m.content} (${m.memoryType})\n`;
      const tokens = this.estimateTokens(line);
      if (usedTokens + tokens > maxTokens * 0.6) break;
      usedTokens += tokens;
      includedImportant.push(m);
      seen.add(m.id);
    }

    // Add recent memories until budget is full
    for (const m of recent) {
      if (seen.has(m.id)) continue;
      const line = `- ${m.content}\n`;
      const tokens = this.estimateTokens(line);
      if (usedTokens + tokens > maxTokens) break;
      usedTokens += tokens;
      includedRecent.push(m);
      seen.add(m.id);
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
