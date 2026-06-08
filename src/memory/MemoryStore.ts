import type { Memory, CompiledContext } from "../types.js";
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
}

const EMBEDDING_BATCH_SIZE = 2048;

export class MemoryStore {
  private storage: StorageProvider;
  private embedding?: EmbeddingProvider;
  private summarizer?: Summarizer;
  private pruner: Pruner;
  private compiler: ContextCompiler;
  private embedOnStore: boolean;

  constructor(config: MemoryStoreConfig) {
    this.storage = config.storage;
    this.embedding = config.embedding;
    this.embedOnStore = config.embedOnStore ?? true;
    if (config.llm) {
      this.summarizer = new Summarizer(config.llm, config.summarizationPrompt);
    }
    this.pruner = new Pruner();
    this.compiler = new ContextCompiler();
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    // On conflict "append": deduplicate by content hash, update existing instead
    if (input.onConflict === "append") {
      const hash = this._hashContent(input.actorId, input.content);
      const existing = await this.storage.retrieve({ actorId: input.actorId, limit: 1000 });
      const match = existing.find(
        (m) => this._hashContent(m.actorId, m.content) === hash
      );
      if (match) {
        // Upsert: update existing instead of creating duplicate
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
        return updated;
      }
    }

    let withEmbedding = input;
    if (this.embedding && this.embedOnStore) {
      const embeddings = await this.embedding.embed([input.content]);
      withEmbedding = { ...input, embedding: embeddings[0] };
    }
    const { onConflict: _, ...clean } = withEmbedding;
    return this.storage.store(clean);
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    // Handle onConflict: "append" inputs individually (they need dedup checks)
    const appendInputs = inputs.filter((i) => i.onConflict === "append");
    const normalInputs = inputs.filter((i) => i.onConflict !== "append");

    const results: Memory[] = [];

    // Process append inputs one-by-one through store() for dedup
    for (const input of appendInputs) {
      results.push(await this.store(input));
    }

    if (normalInputs.length === 0) return results;

    if (this.embedding && this.embedOnStore) {
      for (let i = 0; i < normalInputs.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = normalInputs.slice(i, i + EMBEDDING_BATCH_SIZE);
        const texts = batch.map((inp) => inp.content);
        const embeddings = await this.embedding!.embed(texts);
        const enriched = batch.map((input, j) => ({ ...input, embedding: embeddings[j] }));
        const stored = await this.storage.storeBatch(enriched);
        results.push(...stored);
      }
    } else {
      const stored = await this.storage.storeBatch(normalInputs);
      results.push(...stored);
    }

    return results;
  }

  async get(id: string): Promise<Memory | null> {
    return this.storage.get(id);
  }

  async delete(id: string): Promise<void> {
    return this.storage.delete(id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    return this.storage.deleteMany(ids);
  }

  async touch(id: string): Promise<void> {
    const memory = await this.storage.get(id);
    if (!memory) throw notFound("Memory", id);
    if (this.storage.touch) {
      return this.storage.touch(id);
    }
    // legacy fallback: storage doesn't support in-place touch
    await this.storage.delete(id);
    await this.storage.store({
      actorId: memory.actorId,
      content: memory.content,
      memoryType: memory.memoryType,
      importance: memory.importance,
      emotionalValence: memory.emotionalValence,
      tags: memory.tags,
      embedding: memory.embedding,
      sourceId: memory.sourceId,
      metadata: memory.metadata,
      expiresAt: memory.expiresAt,
    });
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    return this.storage.count(filter);
  }

  async retrieve(query: MemoryRetrieveQuery): Promise<Memory[]> {
    let embedding: number[] | undefined;
    if (this.embedding && query.query && (query.strategy === "semantic" || query.strategy === "hybrid")) {
      const vecs = await this.embedding.embed([query.query]);
      embedding = vecs[0];
    }
    return this.storage.retrieve(query, embedding);
  }

  async compileContext(options: ContextOptions): Promise<CompiledContext> {
    const maxTokens = options.maxTokens ?? 2000;
    // Fetch up to 50 memories; compiler will truncate to meet token budget
    const memories = await this.storage.retrieve({ actorId: options.actorId, limit: 50 });
    return this.compiler.compile(memories, { ...options, maxTokens });
  }

  async summarize(
    options: SummarizeOptions,
    onError?: (err: Error) => void
  ): Promise<{ summary: Memory; deletedCount: number }> {
    if (!this.summarizer) {
      throw validationError("No LLM configured for summarization");
    }

    const allMemories = await this.storage.retrieve({
      actorId: options.actorId,
      memoryTypes: options.memoryTypes ?? ["interaction"],
      limit: 1000,
      strategy: "recent",
    });

    let toSummarize = allMemories;
    if (options.olderThan) {
      toSummarize = toSummarize.filter((m) => m.createdAt < options.olderThan!);
    }
    if (options.skipMostRecent) {
      // Sort chronological (oldest first), skip most recent N, keep the rest
      const sorted = [...toSummarize].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      toSummarize = sorted.slice(0, Math.max(0, sorted.length - options.skipMostRecent));
    }
    if (options.targetCount && toSummarize.length > options.targetCount) {
      // Keep only the oldest targetCount (most stale, best to summarize)
      const sorted = [...toSummarize].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      toSummarize = sorted.slice(0, options.targetCount);
    }

    if (toSummarize.length === 0) {
      throw validationError("No memories to summarize");
    }

    let summaryContent: string;
    try {
      const result = await this.summarizer.summarize(toSummarize, options);
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

  async prune(strategy: PruneStrategy): Promise<{ pruned: string[]; count: number }> {
    const allMemories = await this.storage.retrieve({ limit: 10000 });
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
    const allMemories = await this.storage.retrieve({ limit: 10000 });
    const kept = this.pruner.execute(allMemories, strategy);
    const keptIds = new Set(kept.map((k) => k.id));
    const wouldPrune = allMemories.filter((m) => !keptIds.has(m.id)).map((m) => m.id);
    return { wouldPrune, count: wouldPrune.length };
  }

  async export(): Promise<Memory[]> {
    return this.storage.retrieve({ limit: 100000 });
  }

  private _hashContent(actorId: string, content: string): string {
    const normalized = `${actorId}::${content.toLowerCase().trim()}`;
    // FNV-1a 64-bit — fast, low collision probability for content dedup
    let hash = 14695981039346656037n; // FNV offset basis
    for (let i = 0; i < normalized.length; i++) {
      hash ^= BigInt(normalized.charCodeAt(i));
      hash *= 1099511628211n; // FNV prime
    }
    return hash.toString(36);
  }
}
