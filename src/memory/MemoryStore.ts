import type { Memory, CompiledContext, MemoryStats } from "../types.js";
import type {
  StorageProvider,
  EmbeddingProvider,
  LLMProvider,
  MemoryStoreInput,
  MemoryRetrieveQuery,
  MemoryCountFilter,
  ContextOptions,
  SummarizeOptions,
  PruneStrategy,
  TokenCounter,
} from "../interfaces.js";
import { Summarizer } from "./Summarizer.js";
import { Pruner } from "./Pruner.js";
import { ContextCompiler } from "./ContextCompiler.js";
import { notFound, validationError } from "../errors.js";

export interface MemoryStoreConfig {
  storage: StorageProvider;
  embedding?: EmbeddingProvider;
  llm?: LLMProvider;
  embedOnStore?: boolean;
  summarizationPrompt?: string;
  tokenCounter?: TokenCounter;
  contextImportantRatio?: number;
  limits?: {
    dedupScan?: number;
    contextScan?: number;
    summarizeScan?: number;
    pruneScan?: number;
    exportScan?: number;
    purgeScan?: number;
  };
}

const EMBEDDING_BATCH_SIZE = 2048;

export class MemoryStore {
  private storage: StorageProvider;
  private embedding?: EmbeddingProvider;
  private summarizer?: Summarizer;
  private pruner: Pruner;
  private compiler: ContextCompiler;
  private embedOnStore: boolean;
  private limits: Required<NonNullable<MemoryStoreConfig["limits"]>>;
  private contentHashIndex: Map<string, string> | null = null;
  private initialized = false;

  private async _ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.storage.initialize();
      this.initialized = true;
    }
  }

  constructor(config: MemoryStoreConfig) {
    this.storage = config.storage;
    this.embedding = config.embedding;
    this.embedOnStore = config.embedOnStore ?? true;
    if (config.llm) {
      this.summarizer = new Summarizer(config.llm, config.summarizationPrompt);
    }
    this.pruner = new Pruner();
    this.compiler = new ContextCompiler(config.tokenCounter, config.contextImportantRatio);
    this.limits = {
      dedupScan: 1000,
      contextScan: 50,
      summarizeScan: 1000,
      pruneScan: 10000,
      exportScan: 100000,
      purgeScan: 100000,
      ...config.limits,
    };
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    await this._ensureInit();
    if (input.onConflict === "append") {
      await this._ensureHashIndex();
      const hash = this._hashContent(input.actorId, input.content);
      const existingId = this.contentHashIndex!.get(hash);
      if (existingId) {
        const match = await this.storage.get(existingId);
        if (match) {
          const mergedTags = [...new Set([...(match.tags ?? []), ...(input.tags ?? [])])];
          const updated = await this.storage.store({
            id: match.id,
            actorId: match.actorId,
            content: match.content,
            memoryType: match.memoryType,
            importance: input.importance ?? match.importance,
            emotionalValence: input.emotionalValence ?? match.emotionalValence,
            tags: mergedTags,
            embedding: match.embedding,
            sourceId: input.sourceId ?? match.sourceId,
            metadata: { ...match.metadata, ...input.metadata },
            expiresAt: input.expiresAt ?? match.expiresAt,
          });
          this.contentHashIndex!.set(hash, updated.id);
          return updated;
        }
      }
    }

    let withEmbedding = input;
    if (this.embedding && this.embedOnStore) {
      const embeddings = await this.embedding.embed([input.content]);
      withEmbedding = { ...input, embedding: embeddings[0] };
    }
    const { onConflict: _, ...clean } = withEmbedding;
    const memory = await this.storage.store(clean);
    if (this.contentHashIndex !== null) {
      const hash = this._hashContent(memory.actorId, memory.content);
      this.contentHashIndex.set(hash, memory.id);
    }
    return memory;
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    await this._ensureInit();
    const appendInputs = inputs.filter((i) => i.onConflict === "append");
    const normalInputs = inputs.filter((i) => i.onConflict !== "append");

    const results: Memory[] = [];

    for (const input of appendInputs) {
      results.push(await this.store(input));
    }

    if (normalInputs.length === 0) return results;

    let stored: Memory[];
    if (this.embedding && this.embedOnStore) {
      const enrichedResults: Memory[] = [];
      for (let i = 0; i < normalInputs.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = normalInputs.slice(i, i + EMBEDDING_BATCH_SIZE);
        const texts = batch.map((inp) => inp.content);
        const embeddings = await this.embedding!.embed(texts);
        const enriched = batch.map((input, j) => ({ ...input, embedding: embeddings[j] }));
        const batchResults = await this.storage.storeBatch(enriched);
        enrichedResults.push(...batchResults);
      }
      stored = enrichedResults;
    } else {
      stored = await this.storage.storeBatch(normalInputs);
    }

    if (this.contentHashIndex !== null) {
      for (const mem of stored) {
        const hash = this._hashContent(mem.actorId, mem.content);
        this.contentHashIndex.set(hash, mem.id);
      }
    }

    results.push(...stored);
    return results;
  }

  async get(id: string): Promise<Memory | null> {
    await this._ensureInit();
    return this.storage.get(id);
  }

  async delete(id: string): Promise<void> {
    await this._ensureInit();
    return this.storage.delete(id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    await this._ensureInit();
    return this.storage.deleteMany(ids);
  }

  async touch(id: string): Promise<void> {
    await this._ensureInit();
    const memory = await this.storage.get(id);
    if (!memory) throw notFound("Memory", id);
    if (this.storage.touch) {
      return this.storage.touch(id);
    }
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    await this._ensureInit();
    return this.storage.count(filter);
  }

  async retrieve(query: MemoryRetrieveQuery): Promise<Memory[]> {
    await this._ensureInit();
    let embedding: number[] | undefined;
    if (this.embedding && query.query && (query.strategy === "semantic" || query.strategy === "hybrid")) {
      const vecs = await this.embedding.embed([query.query]);
      embedding = vecs[0];
    }
    let results = await this.storage.retrieve(query, embedding);
    if (query.createdAfter) {
      results = results.filter((m) => m.createdAt >= query.createdAfter!);
    }
    if (query.createdBefore) {
      results = results.filter((m) => m.createdAt <= query.createdBefore!);
    }
    return results;
  }

  async compileContext(options: ContextOptions): Promise<CompiledContext> {
    await this._ensureInit();
    const maxTokens = options.maxTokens ?? 2000;
    const memories = await this.storage.retrieve({
      actorId: options.actorId,
      limit: this.limits.contextScan,
      strategy: options.retrieveStrategy,
    });
    return this.compiler.compile(memories, { ...options, maxTokens });
  }

  async summarize(
    options: SummarizeOptions,
    onError?: (err: Error) => void
  ): Promise<{ summary: Memory; deletedCount: number }> {
    await this._ensureInit();
    if (!this.summarizer) {
      throw validationError("No LLM configured for summarization");
    }

    const allMemories = await this.storage.retrieve({
      actorId: options.actorId,
      memoryTypes: options.memoryTypes ?? ["interaction"],
      limit: this.limits.summarizeScan,
      strategy: "recent",
    });

    let toSummarize = allMemories;
    if (options.olderThan) {
      toSummarize = toSummarize.filter((m) => m.createdAt < options.olderThan!);
    }
    if (options.skipMostRecent) {
      const sorted = [...toSummarize].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      toSummarize = sorted.slice(0, Math.max(0, sorted.length - options.skipMostRecent));
    }
    if (options.targetCount && toSummarize.length > options.targetCount) {
      const sorted = [...toSummarize].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      toSummarize = sorted.slice(0, options.targetCount);
    }

    if (toSummarize.length === 0) {
      throw validationError("No memories to summarize");
    }

    let summaryContent: string;
    try {
      const result = await this.summarizer.summarize(toSummarize, options, options.prompt);
      summaryContent = result.summaryContent;
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    const summary: Memory = await this.storage.store({
      actorId: options.actorId ?? toSummarize[0].actorId,
      content: summaryContent,
      memoryType: "summary",
      importance: Math.max(...toSummarize.map((m) => m.importance)),
      emotionalValence:
        toSummarize.reduce((sum, m) => sum + m.emotionalValence, 0) / toSummarize.length,
      tags: ["summary"],
      sourceId: toSummarize[0].id,
    });

    let deletedCount = 0;
    if (!options.keepOriginals) {
      const ids = toSummarize.map((m) => m.id);
      deletedCount = await this.storage.deleteMany(ids);
    }

    return { summary, deletedCount };
  }

  async *summarizeStream(options: SummarizeOptions): AsyncIterable<{ chunk: string; text: string }> {
    await this._ensureInit();
    if (!this.summarizer) {
      throw validationError("No LLM configured for summarization");
    }

    const allMemories = await this.storage.retrieve({
      actorId: options.actorId,
      memoryTypes: options.memoryTypes ?? ["interaction"],
      limit: this.limits.summarizeScan,
      strategy: "recent",
    });

    let toSummarize = allMemories;
    if (options.olderThan) {
      toSummarize = toSummarize.filter((m) => m.createdAt < options.olderThan!);
    }
    if (options.skipMostRecent) {
      const sorted = [...toSummarize].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      toSummarize = sorted.slice(0, Math.max(0, sorted.length - options.skipMostRecent));
    }
    if (options.targetCount && toSummarize.length > options.targetCount) {
      const sorted = [...toSummarize].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      toSummarize = sorted.slice(0, options.targetCount);
    }

    if (toSummarize.length === 0) {
      throw validationError("No memories to summarize");
    }

    yield* this.summarizer.summarizeStream(toSummarize, options, options.prompt);
  }

  async prune(strategy: PruneStrategy): Promise<{ pruned: string[]; count: number }> {
    await this._ensureInit();
    const allMemories = await this.storage.retrieve({ limit: this.limits.pruneScan });
    const kept = this.pruner.execute(allMemories, strategy);
    const keptIds = new Set(kept.map((k) => k.id));
    const prunedIds = allMemories.filter((m) => !keptIds.has(m.id)).map((m) => m.id);
    let count = 0;
    if (prunedIds.length > 0) {
      count = await this.storage.deleteMany(prunedIds);
    }
    return { pruned: prunedIds, count };
  }

  async dryRunPrune(strategy: PruneStrategy): Promise<{ wouldPrune: string[]; count: number }> {
    await this._ensureInit();
    const allMemories = await this.storage.retrieve({ limit: this.limits.pruneScan });
    const kept = this.pruner.execute(allMemories, strategy);
    const keptIds = new Set(kept.map((k) => k.id));
    const wouldPrune = allMemories.filter((m) => !keptIds.has(m.id)).map((m) => m.id);
    return { wouldPrune, count: wouldPrune.length };
  }

  async export(actorId?: string): Promise<Memory[]> {
    await this._ensureInit();
    return this.storage.retrieve({ actorId, limit: this.limits.exportScan });
  }

  async stats(actorId?: string): Promise<MemoryStats> {
    await this._ensureInit();
    const memories = await this.storage.retrieve({ actorId, limit: this.limits.exportScan });
    const now = new Date();
    const byType: Record<string, number> = {};
    const byActor: Record<string, { count: number; oldest: Date; newest: Date; totalImportance: number }> = {};
    let totalImportance = 0;
    let expired = 0;
    let oldest: Date | null = null;
    let newest: Date | null = null;

    for (const m of memories) {
      totalImportance += m.importance;
      byType[m.memoryType] = (byType[m.memoryType] ?? 0) + 1;

      const actor = byActor[m.actorId] ?? { count: 0, oldest: m.createdAt, newest: m.createdAt, totalImportance: 0 };
      actor.count++;
      actor.totalImportance += m.importance;
      if (m.createdAt < actor.oldest) actor.oldest = m.createdAt;
      if (m.createdAt > actor.newest) actor.newest = m.createdAt;
      byActor[m.actorId] = actor;

      if (m.expiresAt && m.expiresAt <= now) expired++;
      if (!oldest || m.createdAt < oldest) oldest = m.createdAt;
      if (!newest || m.createdAt > newest) newest = m.createdAt;
    }

    const byActorFinal: MemoryStats["byActor"] = {};
    for (const [id, a] of Object.entries(byActor)) {
      byActorFinal[id] = { count: a.count, oldest: a.oldest, newest: a.newest, avgImportance: a.totalImportance / a.count };
    }

    return {
      total: memories.length,
      expired,
      oldest,
      newest,
      avgImportance: memories.length > 0 ? totalImportance / memories.length : 0,
      byType: byType as Record<string, number>,
      byActor: byActorFinal,
    };
  }

  async purgeActor(actorId: string): Promise<number> {
    await this._ensureInit();
    const memories = await this.storage.retrieve({ actorId, limit: this.limits.purgeScan ?? 100000 });
    if (memories.length === 0) return 0;
    return this.storage.deleteMany(memories.map((m) => m.id));
  }

  async merge(ids: string[]): Promise<Memory> {
    await this._ensureInit();
    if (ids.length < 2) throw validationError("merge requires at least 2 memory IDs");

    const memories: Memory[] = [];
    for (const id of ids) {
      const m = await this.storage.get(id);
      if (m) memories.push(m);
    }
    if (memories.length < 2) throw validationError("At least 2 of the provided IDs must exist");

    const sorted = memories.sort((a, b) => b.importance - a.importance);
    const winner = sorted[0];
    const rest = sorted.slice(1);

    const mergedContent = [
      winner.content,
      "",
      "--- merged from " + rest.length + " related memories ---",
      ...rest.map((m) => "- " + m.content),
    ].join("\n");

    const mergedTags = [...new Set(memories.flatMap((m) => m.tags))];
    const mergedMetadata = {
      ...winner.metadata,
      mergedFrom: rest.map((m) => m.id),
    };

    const updated = await this.storage.store({
      id: winner.id,
      actorId: winner.actorId,
      content: mergedContent,
      memoryType: winner.memoryType,
      importance: winner.importance,
      emotionalValence: winner.emotionalValence,
      tags: mergedTags,
      embedding: winner.embedding,
      sourceId: winner.sourceId,
      metadata: mergedMetadata,
      expiresAt: winner.expiresAt,
    });

    await this.storage.deleteMany(rest.map((m) => m.id));

    return updated;
  }

  private async _ensureHashIndex(): Promise<void> {
    if (this.contentHashIndex !== null) return;
    this.contentHashIndex = new Map();
    const existing = await this.storage.retrieve({ limit: this.limits.dedupScan });
    for (const m of existing) {
      const hash = this._hashContent(m.actorId, m.content);
      this.contentHashIndex.set(hash, m.id);
    }
  }

  private _hashContent(actorId: string, content: string): string {
    const normalized = `${actorId}::${content.toLowerCase().trim()}`;
    let hash = 14695981039346656037n;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= BigInt(normalized.charCodeAt(i));
      hash *= 1099511628211n;
    }
    return hash.toString(36);
  }
}
