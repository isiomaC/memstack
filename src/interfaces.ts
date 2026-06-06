import type { Memory, ProcessResult, MemoryType } from "./types.js";

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
  summarize(options: SummarizeOptions, onError?: (err: Error) => void): Promise<{ summary: Memory; deletedCount: number }>;
  prune(strategy: PruneStrategy): Promise<{ pruned: string[]; count: number }>;
  dryRunPrune(strategy: PruneStrategy): Promise<{ wouldPrune: string[]; count: number }>;
  export(): Promise<Memory[]>;
}

export interface MemoryCountFilter {
  actorId?: string;
  memoryType?: MemoryType;
  minImportance?: number;
}

export interface MemoryRetrieveQuery {
  actorId?: string;
  query?: string;
  memoryTypes?: MemoryType[];
  tags?: string[];
  limit?: number;
  strategy?: "semantic" | "hybrid" | "recent" | "important";
}

export interface ContextOptions {
  actorId: string;
  maxTokens?: number;
  memoryTypes?: MemoryType[];
}

export interface SummarizeOptions {
  actorId?: string;
  olderThan?: Date;
  skipMostRecent?: number;
  targetCount?: number;
  memoryTypes?: MemoryType[];
  keepOriginals?: boolean;
}

export interface PruneStrategy {
  type: "byAge" | "byImportance" | "byCount" | "byType" | "custom";
  maxAge?: number;
  minImportance?: number;
  maxPerActor?: number;
  memoryTypes?: MemoryType[];
  /** Custom predicate: return true for memories that should be REMOVED. */
  shouldRemove?: (memory: Memory) => boolean;
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
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

export interface StorageProvider {
  initialize(): Promise<void>;
  store(memory: MemoryStoreInput): Promise<Memory>;
  storeBatch(memories: MemoryStoreInput[]): Promise<Memory[]>;
  get(id: string): Promise<Memory | null>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<number>;
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
}

export type { ProcessResult };
