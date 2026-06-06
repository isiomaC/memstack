import type { Memory } from "../types.js";
import type { PruneStrategy } from "../interfaces.js";

export class Pruner {
  execute(memories: Memory[], strategy: PruneStrategy): Memory[] {
    switch (strategy.type) {
      case "byAge":
        return this.pruneByAge(memories, strategy);
      case "byImportance":
        return this.pruneByImportance(memories, strategy);
      case "byCount":
        return this.pruneByCount(memories, strategy);
      case "byType":
        return this.pruneByType(memories, strategy);
      case "custom":
        return this.pruneCustom(memories, strategy);
      default:
        return memories;
    }
  }

  dryRun(memories: Memory[], strategy: PruneStrategy): Memory[] {
    return this.execute(memories, strategy);
  }

  private pruneByAge(memories: Memory[], strategy: PruneStrategy): Memory[] {
    if (!strategy.maxAge) return memories; // keep all
    const cutoff = Date.now() - strategy.maxAge;
    return memories.filter((m) => m.createdAt.getTime() >= cutoff);
  }

  private pruneByImportance(memories: Memory[], strategy: PruneStrategy): Memory[] {
    const threshold = strategy.minImportance ?? 0.5;
    return memories.filter((m) => m.importance >= threshold);
  }

  private pruneByCount(memories: Memory[], strategy: PruneStrategy): Memory[] {
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

  private pruneByType(memories: Memory[], strategy: PruneStrategy): Memory[] {
    if (!strategy.memoryTypes || strategy.memoryTypes.length === 0) return memories;
    return memories.filter((m) => strategy.memoryTypes!.includes(m.memoryType));
  }

  private pruneCustom(memories: Memory[], strategy: PruneStrategy): Memory[] {
    if (!strategy.predicate) return memories;
    return memories.filter((m) => !strategy.predicate!(m));
  }
}
