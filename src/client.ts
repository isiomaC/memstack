import type { Memory, ProcessResult, MemStackSnapshot, HealthStatus } from "./types.js";
import type { MemStackConfig, ProcessInput, MemoryStoreInput } from "./interfaces.js";
import { MemoryStore } from "./memory/MemoryStore.js";
import { InMemoryStorage } from "./adapters/storage/memory.js";
import { configError, validationError } from "./errors.js";

export class MemStack {
  readonly memory: MemoryStore;

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
  }

  async process(input: ProcessInput): Promise<ProcessResult> {
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
    this.config.hooks?.onMemoryStored?.(memory);

    // Auto-summarize if threshold is hit
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

    // Auto-prune if configured
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

    return { memory, summaryCreated };
  }

  async export(): Promise<MemStackSnapshot> {
    const memories = await this.memory.export();
    return {
      version: 1,
      memories,
      exportedAt: new Date().toISOString(),
    };
  }

  async import(snapshot: MemStackSnapshot): Promise<void> {
    if (snapshot.version !== 1) {
      throw validationError(`Unsupported snapshot version: ${snapshot.version}`);
    }
    await this.memory.storeBatch(snapshot.memories);
  }

  async health(): Promise<HealthStatus> {
    const status: HealthStatus = { storage: false, llm: false, embedding: false };

    try {
      await this.memory.count();
      status.storage = true;
    } catch { /* storage check failed */ }

    if (this.config.llm) {
      try {
        await this.config.llm.complete({ system: "ok", user: "health" });
        status.llm = true;
      } catch { /* llm check failed */ }
    } else {
      status.llm = true;
    }

    if (this.config.embedding) {
      try {
        await this.config.embedding.embed(["health check"]);
        status.embedding = true;
      } catch { /* embedding check failed */ }
    } else {
      status.embedding = true;
    }

    return status;
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
