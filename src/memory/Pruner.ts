import type { Memory } from "../types.js";
import type { PruneStrategy } from "../interfaces.js";

export class Pruner {
  /** Returns memories to KEEP after applying the strategy. */
  execute(memories: Memory[], strategy: PruneStrategy): Memory[] {
    switch (strategy.type) {
      case "byAge":
        return this.keepByAge(memories, strategy);
      case "byImportance":
        return this.keepByImportance(memories, strategy);
      case "byCount":
        return this.keepByCount(memories, strategy);
      case "byType":
        return this.removeByType(memories, strategy);
      case "custom":
        return this.removeCustom(memories, strategy);
      case "compose":
        return this.keepCompose(memories, strategy);
      default:
        return memories;
    }
  }

  dryRun(memories: Memory[], strategy: PruneStrategy): Memory[] {
    return this.execute(memories, strategy);
  }

  private keepByAge(memories: Memory[], strategy: PruneStrategy): Memory[] {
    if (!strategy.maxAge) return memories;
    const cutoff = Date.now() - strategy.maxAge;
    return memories.filter((m) => m.createdAt.getTime() >= cutoff);
  }

  private keepByImportance(memories: Memory[], strategy: PruneStrategy): Memory[] {
    const threshold = strategy.minImportance ?? 0.5;
    return memories.filter((m) => m.importance >= threshold);
  }

  private keepByCount(memories: Memory[], strategy: PruneStrategy): Memory[] {
    const maxPerActor = strategy.maxPerActor ?? 100;
    const grouped = new Map<string, Memory[]>();
    for (const m of memories) {
      const list = grouped.get(m.actorId) || [];
      list.push(m);
      grouped.set(m.actorId, list);
    }

    const kept: Memory[] = [];
    for (const [, actorMemories] of grouped) {
      const sorted = [...actorMemories].sort((a, b) => b.importance - a.importance);
      kept.push(...sorted.slice(0, maxPerActor));
    }
    return kept;
  }

  /** Remove memories of specified types. Opposite of filtering — removes the matches. */
  private removeByType(memories: Memory[], strategy: PruneStrategy): Memory[] {
    if (!strategy.memoryTypes || strategy.memoryTypes.length === 0) return memories;
    return memories.filter((m) => !strategy.memoryTypes!.includes(m.memoryType));
  }

  /** Remove memories matching the predicate. Predicate returns true = should be removed. */
  private removeCustom(memories: Memory[], strategy: PruneStrategy): Memory[] {
    if (!strategy.shouldRemove) return memories;
    return memories.filter((m) => !strategy.shouldRemove!(m));
  }

  /** Apply sub-strategies cumulatively: kept memories must pass ALL. */
  private keepCompose(memories: Memory[], strategy: PruneStrategy): Memory[] {
    if (!strategy.strategies || strategy.strategies.length === 0) {
      return memories;
    }

    let kept = memories;
    for (const sub of strategy.strategies) {
      kept = this.execute(kept, sub);
    }
    return kept;
  }
}
