import type { Memory, ProcessResult, MemStackSnapshot, HealthStatus } from "./types.js";
import type { MemStackConfig, ProcessInput, MemoryStoreInput, StorageProvider } from "./interfaces.js";
import { MemoryStore } from "./memory/MemoryStore.js";
import { InMemoryStorageAdapter } from "./adapters/storage/memory.js";
import { configError, validationError } from "./errors.js";

export class MemStack {
  readonly memory: MemoryStore;

  private config: MemStackConfig;
  private storage: StorageProvider;
  private processCounts = new Map<string, number>();
  private pruneCheckCount = 0;

  constructor(config: MemStackConfig) {
    if (!config.llm) {
      throw configError("LLM provider is required");
    }

    this.config = config;
    this.storage = config.storage ?? new InMemoryStorageAdapter();

    this.memory = new MemoryStore({
      storage: this.storage,
      embedding: config.embedding,
      llm: config.llm,
      embedOnStore: config.defaults?.embedOnStore ?? true,
      summarizationPrompt: config.defaults?.summarizationPrompt,
    });
  }

  async process(input: ProcessInput): Promise<ProcessResult> {
    // Auto-enrichment: importance + tags via LLM when not provided
    let importance = input.importance;
    let tags = input.tags;

    const needImportance = importance === undefined && this.config.defaults?.autoImportance;
    const needTags = (!tags || tags.length === 0) && this.config.defaults?.autoTags;

    if (needImportance || needTags) {
      try {
        if (needImportance && needTags) {
          // Batch both into one LLM call
          const result = await this.config.llm.complete({
            system:
              "Analyze the memory and respond with a JSON object: {\"importance\": <0.0-1.0>, \"tags\": [<array of 1-5 lowercase single-word tags>]}. Return ONLY the JSON, nothing else.",
            user: input.content,
            maxTokens: 100,
            temperature: 0,
          });
          const parsed = this._parseEnrichmentJson(result.text);
          if (parsed.importance !== undefined) importance = parsed.importance;
          if (parsed.tags) tags = parsed.tags;
        } else if (needImportance) {
          const result = await this.config.llm.complete({
            system:
              "Rate the importance of the following memory for an AI agent on a scale of 0.0 to 1.0, where 0.0 is trivial and 1.0 is critical. Return ONLY a single float number, nothing else.",
            user: input.content,
            maxTokens: 10,
            temperature: 0,
          });
          const parsed = parseFloat(result.text.trim());
          importance = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.5;
        } else if (needTags) {
          const result = await this.config.llm.complete({
            system:
              "Extract 1-5 concise, lowercase, single-word tags from the following memory. Return ONLY a JSON array of strings, nothing else. Example: [\"combat\", \"goblin\", \"forest\"]",
            user: input.content,
            maxTokens: 80,
            temperature: 0,
          });
          tags = this._parseTagsJson(result.text);
        }
      } catch (err) {
        this.config.hooks?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
          "auto-enrich"
        );
        if (importance === undefined) importance = 0.5;
        if (!tags) tags = [];
      }
    }

    const memoryInput: MemoryStoreInput = {
      actorId: input.actorId,
      content: input.content,
      memoryType: input.memoryType ?? "interaction",
      importance: importance ?? 0.5,
      emotionalValence: input.emotionalValence ?? 0,
      tags: tags ?? [],
      metadata: input.metadata ?? {},
      expiresAt: input.expiresAt,
      onConflict: input.onConflict,
    };

    const memory = await this.memory.store(memoryInput);
    this.config.hooks?.onMemoryStored?.(memory);

    const count = (this.processCounts.get(input.actorId) ?? 0) + 1;
    this.processCounts.set(input.actorId, count);

    // Auto-summarize if threshold is hit
    let summaryCreated: Memory | undefined;
    const threshold = this.config.defaults?.summarizationThreshold ?? 100;
    if (threshold > 0 && count % threshold === 0) {
        try {
          const result = await this.memory.summarize(
            {
              actorId: input.actorId,
              memoryTypes: ["interaction"],
              skipMostRecent: 5,
              targetCount: Math.min(15, count),
            },
            this.config.hooks?.onError
              ? (err) => this.config.hooks!.onError!(err, "summarize")
              : undefined
          );
          summaryCreated = result.summary;
          this.config.hooks?.onSummaryCreated?.(result.summary, result.deletedCount);
        } catch (err) {
          this.config.hooks?.onError?.(
            err instanceof Error ? err : new Error(String(err)),
            "summarize"
          );
        }
    }

    // Auto-prune if configured (throttled)
    this.pruneCheckCount++;
    const pruneStrategy = this.config.defaults?.pruneStrategy;
    const pruneInterval = this.config.defaults?.pruneInterval ?? 100;
    if (pruneStrategy && this.pruneCheckCount % pruneInterval === 0) {
      try {
        const pruneResult = await this.memory.prune(pruneStrategy);
        if (pruneResult.count > 0) {
          this.config.hooks?.onMemoryPruned?.(pruneResult.pruned);
        }
      } catch (err) {
        this.config.hooks?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
          "prune"
        );
      }
    }

    return { memory, summaryCreated };
  }

  async export(actorId?: string): Promise<MemStackSnapshot> {
    const memories = await this.memory.export(actorId);
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
    const memories = snapshot.memories.map((m) => ({
      ...m,
      createdAt: typeof m.createdAt === "string" ? new Date(m.createdAt) : m.createdAt,
      expiresAt: typeof m.expiresAt === "string" ? new Date(m.expiresAt) : m.expiresAt,
    }));
    await this.memory.storeBatch(memories);
  }

  async health(): Promise<HealthStatus> {
    const status: HealthStatus = { storage: false, llm: false, embedding: false };

    try {
      await this.memory.count();
      status.storage = true;
    } catch { /* storage check failed */ }

    try {
      await this.config.llm.complete({ system: "ok", user: "health", maxTokens: 1 });
      status.llm = true;
    } catch { /* llm check failed */ }

    if (this.config.embedding) {
      try {
        await this.config.embedding.embed(["health check"]);
        status.embedding = true;
      } catch { /* embedding check failed */ }
    }

    return status;
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  private _parseEnrichmentJson(
    text: string
  ): { importance?: number; tags?: string[] } {
    try {
      const json = JSON.parse(this._extractJson(text)) as Record<string, unknown>;
      const result: { importance?: number; tags?: string[] } = {};
      if (typeof json.importance === "number" && Number.isFinite(json.importance)) {
        result.importance = Math.max(0, Math.min(1, json.importance));
      }
      if (
        Array.isArray(json.tags) &&
        json.tags.every((t: unknown) => typeof t === "string")
      ) {
        result.tags = (json.tags as string[]).map((t) => t.toLowerCase().trim()).slice(0, 5);
      }
      return result;
    } catch {
      return {};
    }
  }

  private _parseTagsJson(text: string): string[] {
    try {
      const parsed = JSON.parse(this._extractJson(text)) as unknown;
      if (Array.isArray(parsed) && parsed.every((t: unknown) => typeof t === "string")) {
        return (parsed as string[]).map((t) => t.toLowerCase().trim()).slice(0, 5);
      }
    } catch {
      // Fallback: try comma-separated
    }
    return text
      .split(",")
      .map((t) => t.replace(/[\[\]"]/g, "").trim().toLowerCase())
      .filter((t) => t.length > 0)
      .slice(0, 5);
  }

  /** Strip markdown code fences and extract the JSON payload from LLM output. */
  private _extractJson(text: string): string {
    let cleaned = text.trim();
    // Remove ```json ... ``` or ``` ... ``` fences
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    return cleaned;
  }
}
