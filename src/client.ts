import type { Memory, ProcessResult, MemStackSnapshot, HealthStatus } from "./types.js";
import type {
  MemStackConfig,
  ProcessInput,
  MemoryStoreInput,
  RelationshipDeltaInput,
} from "./interfaces.js";
import { MemoryStore } from "./memory/MemoryStore.js";
import { RelationshipGraph } from "./relationships/RelationshipGraph.js";
import { QuestManager } from "./quests/QuestManager.js";
import { InMemoryStorage } from "./adapters/storage/memory.js";
import { configError, validationError } from "./errors.js";

export class MemStack {
  readonly memory: MemoryStore;
  readonly relationships: RelationshipGraph;
  readonly quests: QuestManager;

  private config: MemStackConfig;
  private storage: InMemoryStorage;

  constructor(config: MemStackConfig) {
    if (!config.llm) {
      throw configError("LLM provider is required");
    }

    this.config = config;
    this.storage = (config.storage as InMemoryStorage) ?? new InMemoryStorage();

    this.memory = new MemoryStore({
      storage: this.storage,
      embedding: config.embedding,
      llm: config.llm,
      embedOnStore: config.defaults?.embedOnStore ?? true,
    });

    this.relationships = new RelationshipGraph();
    this.quests = new QuestManager();
  }

  async process(input: ProcessInput): Promise<ProcessResult> {
    // 1. Store the memory
    const memoryInput: MemoryStoreInput = {
      actorId: input.actorId,
      content: input.content,
      memoryType: input.memoryType ?? "interaction",
      importance: input.importance ?? 0.5,
      emotionalValence: input.emotionalValence ?? 0,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      expiresAt: input.expiresAt,
    };

    const memory = await this.memory.store(memoryInput);

    // 2. Fire hook
    this.config.hooks?.onMemoryStored?.(memory);

    // 3. Update relationship if targetId provided
    let relationshipUpdate: ProcessResult["relationshipUpdate"];
    if (input.targetId) {
      let previous: import("./types.js").Relationship | null = null;
      try {
        previous = await this.relationships.get(input.actorId, input.targetId);
      } catch {
        // First interaction
      }

      const deltas: RelationshipDeltaInput = input.relationshipDelta ?? {
        affinity: input.emotionalValence ? input.emotionalValence * 5 : 0,
      };

      let current: import("./types.js").Relationship;
      try {
        if (previous) {
          current = await this.relationships.updateDeltas(input.actorId, input.targetId, deltas);
        } else {
          current = await this.relationships.set(input.actorId, input.targetId, {
            affinity: deltas.affinity ?? 0,
            trust: deltas.trust ?? 0,
            fear: deltas.fear ?? 0,
            respect: deltas.respect ?? 0,
          });
        }
      } catch {
        // If relationship update fails, continue without it
        current = previous!;
      }

      if (current) {
        relationshipUpdate = { previous: previous!, current };
        this.config.hooks?.onRelationshipChanged?.(current);
      }
    }

    // 4. Auto-summarize if threshold is hit
    let summaryCreated: Memory | undefined;
    const threshold = this.config.defaults?.summarizationThreshold ?? 100;
    if (threshold > 0) {
      const count = await this.memory.count({
        actorId: input.actorId,
        memoryType: "interaction",
      });
      if (count % threshold === 0 && count > 0) {
        try {
          const result = await this.memory.summarize({
            actorId: input.actorId,
            memoryTypes: ["interaction"],
            skipMostRecent: 5,
            targetCount: Math.min(15, count),
          });
          summaryCreated = result.summary;
          this.config.hooks?.onSummaryCreated?.(result.summary, result.deletedCount);
        } catch {
          // Summarization is best-effort
        }
      }
    }

    // 5. Check for quest triggers (simplified: look for objectives with matching tags)
    let questTriggers: import("./types.js").Quest[] | undefined;
    if (input.tags && input.tags.length > 0) {
      const activeQuests = await this.quests.list({ status: ["accepted", "in_progress"] });
      for (const quest of activeQuests) {
        let updated = false;
        for (const obj of quest.objectives) {
          if (!obj.isComplete && input.tags.some((t) => obj.description.toLowerCase().includes(t.toLowerCase()))) {
            await this.quests.updateObjective(quest.id, obj.index, true);
            updated = true;
          }
        }
        if (updated) {
          const refreshed = await this.quests.get(quest.id);
          if (refreshed) {
            questTriggers = questTriggers ?? [];
            questTriggers.push(refreshed);
            this.config.hooks?.onQuestUpdated?.(refreshed);
          }
        }
      }
    }

    // 6. Auto-prune if configured
    const pruneStrategy = this.config.defaults?.pruneStrategy;
    if (pruneStrategy) {
      try {
        const pruneResult = await this.memory.prune(pruneStrategy);
        if (pruneResult.count > 0) {
          this.config.hooks?.onMemoryPruned?.(pruneResult.pruned);
        }
      } catch {
        // Pruning is best-effort
      }
    }

    return {
      memory,
      relationshipUpdate,
      questTriggers,
      summaryCreated,
    };
  }

  async export(): Promise<MemStackSnapshot> {
    const memories = await this.memory.export();
    return {
      version: 1,
      memories,
      relationships: this.relationships.export(),
      quests: this.quests.export(),
      exportedAt: new Date().toISOString(),
    };
  }

  async import(snapshot: MemStackSnapshot): Promise<void> {
    if (snapshot.version !== 1) {
      throw validationError(`Unsupported snapshot version: ${snapshot.version}`);
    }
    await this.memory.storeBatch(snapshot.memories);
    this.relationships.import(snapshot.relationships);
    this.quests.import(snapshot.quests);
  }

  async health(): Promise<HealthStatus> {
    const status: HealthStatus = {
      storage: false,
      llm: false,
      embedding: false,
    };

    try {
      await this.memory.count();
      status.storage = true;
    } catch {
      // Storage check failed
    }

    if (this.config.llm) {
      try {
        await this.config.llm.complete({
          system: "Say 'ok'",
          user: "Health check",
        });
        status.llm = true;
      } catch {
        // LLM check failed
      }
    } else {
      status.llm = true; // no LLM configured means "healthy" for this check
    }

    if (this.config.embedding) {
      try {
        await this.config.embedding.embed(["health check"]);
        status.embedding = true;
      } catch {
        // Embedding check failed
      }
    } else {
      status.embedding = true; // no embedding configured means "not applicable"
    }

    return status;
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
