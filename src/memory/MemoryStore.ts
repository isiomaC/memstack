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
}

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
      this.summarizer = new Summarizer(config.llm);
    }
    this.pruner = new Pruner();
    this.compiler = new ContextCompiler();
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    let withEmbedding = input;
    if (this.embedding && this.embedOnStore) {
      const embeddings = await this.embedding.embed([input.content]);
      withEmbedding = { ...input, embedding: embeddings[0] };
    }
    return this.storage.store(withEmbedding);
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    if (this.embedding && this.embedOnStore) {
      const texts = inputs.map((i) => i.content);
      const embeddings = await this.embedding.embed(texts);
      const enriched = inputs.map((input, i) => ({ ...input, embedding: embeddings[i] }));
      return this.storage.storeBatch(enriched);
    }
    return this.storage.storeBatch(inputs);
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
    // Touch: re-store to update timestamp
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
    const memories = await this.storage.retrieve({ actorId: options.actorId, limit: 50 });
    return this.compiler.compile(memories, options);
  }

  async summarize(options: SummarizeOptions): Promise<{ summary: Memory; deletedCount: number }> {
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
      const sorted = [...toSummarize].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      toSummarize = sorted.slice(options.skipMostRecent);
    }
    if (options.targetCount && toSummarize.length > options.targetCount) {
      toSummarize = toSummarize.slice(-options.targetCount);
    }

    if (toSummarize.length === 0) {
      throw validationError("No memories to summarize");
    }

    const { summaryContent } = await this.summarizer.summarize(toSummarize, options);

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
    const prunedIds = allMemories.filter((m) => !kept.find((k) => k.id === m.id)).map((m) => m.id);
    let count = 0;
    if (prunedIds.length > 0) {
      count = await this.storage.deleteMany(prunedIds);
    }
    return { pruned: prunedIds, count };
  }

  async dryRunPrune(strategy: PruneStrategy): Promise<{ wouldPrune: string[]; count: number }> {
    const allMemories = await this.storage.retrieve({ limit: 10000 });
    const kept = this.pruner.execute(allMemories, strategy);
    const wouldPrune = allMemories.filter((m) => !kept.find((k) => k.id === m.id)).map((m) => m.id);
    return { wouldPrune, count: wouldPrune.length };
  }

  async export(): Promise<Memory[]> {
    return this.storage.retrieve({ limit: 100000 });
  }
}
