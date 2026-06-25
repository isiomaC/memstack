import type { Memory, ProcessResult, MemoryType } from "./types.js";

export type TokenCounter = (text: string) => number;

// ── Memory ──

export interface MemoryStoreInput {
  actorId: string;
  content: string;
  memoryType?: MemoryType;
  importance?: number;
  emotionalValence?: number;
  tags?: string[];
  embedding?: number[];
  sourceId?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
  onConflict?: "append";
  /** Pre-assigned ID. When set, the storage adapter uses it instead of generating one. */
  id?: string;
}

export interface MemoryStore {
  store(input: MemoryStoreInput): Promise<Memory>;
  storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]>;
  get(id: string): Promise<Memory | null>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<number>;
  touch(id: string): Promise<void>;
  count(filter?: MemoryCountFilter): Promise<number>;
  retrieve(query: MemoryRetrieveQuery): Promise<Memory[]>;
  compileContext(options: ContextOptions): Promise<import("./types.js").CompiledContext>;
  purgeActor(actorId: string): Promise<number>;
  summarize(options: SummarizeOptions, onError?: (err: Error) => void): Promise<{ summary: Memory; deletedCount: number }>;
  summarizeStream(options: SummarizeOptions): AsyncIterable<{ chunk: string; text: string }>;
  merge(ids: string[]): Promise<Memory>;
  prune(strategy: PruneStrategy): Promise<{ pruned: string[]; count: number }>;
  dryRunPrune(strategy: PruneStrategy): Promise<{ wouldPrune: string[]; count: number }>;
  export(actorId?: string): Promise<Memory[]>;
  stats(actorId?: string): Promise<import("./types.js").MemoryStats>;
}

export interface MemoryCountFilter {
  actorId?: string;
  memoryType?: MemoryType;
  minImportance?: number;
  createdAfter?: Date;
  createdBefore?: Date;
}

export interface MemoryRetrieveQuery {
  actorId?: string;
  query?: string;
  memoryTypes?: MemoryType[];
  tags?: string[];
  limit?: number;
  strategy?: "semantic" | "hybrid" | "recent" | "important";
  createdAfter?: Date;
  createdBefore?: Date;
}

export interface ContextOptions {
  actorId: string;
  maxTokens?: number;
  memoryTypes?: MemoryType[];
  retrieveStrategy?: "recent" | "important" | "hybrid";
  format?: "markdown" | "messages";
}

export interface SummarizeOptions {
  actorId?: string;
  olderThan?: Date;
  skipMostRecent?: number;
  targetCount?: number;
  memoryTypes?: MemoryType[];
  keepOriginals?: boolean;
  /** Maximum memories per LLM call. When exceeded, memories are split into chunks, summarized independently, then recursively merged. Default 50. */
  chunkSize?: number;
  /** Per-call override for the summarization system prompt. Falls back to constructor prompt. */
  prompt?: string;
}

export interface PruneStrategy {
  type: "byAge" | "byImportance" | "byCount" | "byType" | "custom" | "compose";
  maxAge?: number;
  minImportance?: number;
  maxPerActor?: number;
  memoryTypes?: MemoryType[];
  /** Custom predicate: return true for memories that should be REMOVED. */
  shouldRemove?: (memory: Memory) => boolean;
  /** For "compose" type: sub-strategies applied cumulatively (kept memories must pass ALL). */
  strategies?: PruneStrategy[];
}

// ── Adapters ──

export interface LLMProvider {
  complete(request: {
    system: string;
    user: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{
    text: string;
    tokens: { prompt: number; completion: number; total: number };
  }>;
  /** Optional streaming variant. Returns an async iterable of text chunks. */
  completeStream?(request: {
    system: string;
    user: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): AsyncIterable<{ text: string; tokens: { prompt: number; completion: number; total: number } }>;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  /** Vector dimension length (e.g., 1536 for text-embedding-3-small). */
  dimensions: number;
  /** Maximum number of texts per embed() call. Default: 2048. */
  maxBatchSize?: number;
}

export interface StorageProvider {
  initialize(): Promise<void>;
  store(memory: MemoryStoreInput): Promise<Memory>;
  storeBatch(memories: MemoryStoreInput[]): Promise<Memory[]>;
  get(id: string): Promise<Memory | null>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<number>;
  /** Update the last-accessed timestamp for a memory without changing its content, id, or createdAt. */
  touch?(id: string): Promise<void>;
  retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]>;
  count(filter?: MemoryCountFilter): Promise<number>;
  close(): Promise<void>;
}

// ── MemStack Client ──

export interface MemStackConfig {
  llm: LLMProvider;
  embedding?: EmbeddingProvider;
  storage?: StorageProvider;
  defaults?: {
    summarizationThreshold?: number;
    embedOnStore?: boolean;
    pruneStrategy?: PruneStrategy;
    pruneInterval?: number;   // Prune every N process() calls. Default: 100.
    autoImportance?: boolean; // LLM-based importance scoring when importance not provided
    autoTags?: boolean;       // LLM-based tag extraction when tags not provided
    summarizationPrompt?: string; // Custom prompt for the summarizer
  };
  hooks?: {
    onMemoryStored?: (memory: Memory) => void;
    onMemoryPruned?: (ids: string[]) => void;
    onSummaryCreated?: (summary: Memory, deletedCount: number) => void;
    onError?: (error: Error, context: string) => void;
  };
}

export interface ProcessInput {
  actorId: string;
  content: string;
  memoryType?: MemoryType;
  importance?: number;
  emotionalValence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
  onConflict?: "append";
}

export type { ProcessResult };
