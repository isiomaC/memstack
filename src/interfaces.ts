import type { Memory, ProcessResult } from "./types.js";

// ── Memory ──

export interface MemoryStoreInput {
  actorId: string;
  content: string;
  memoryType?: import("./types.js").MemoryType;
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
  summarize(options: SummarizeOptions): Promise<{ summary: Memory; deletedCount: number }>;
  prune(strategy: PruneStrategy): Promise<{ pruned: string[]; count: number }>;
  dryRunPrune(strategy: PruneStrategy): Promise<{ wouldPrune: string[]; count: number }>;
}

export interface MemoryCountFilter {
  actorId?: string;
  memoryType?: string;
  minImportance?: number;
}

export interface MemoryRetrieveQuery {
  actorId?: string;
  query?: string;
  memoryTypes?: string[];
  tags?: string[];
  limit?: number;
  strategy?: "semantic" | "hybrid" | "recent" | "important";
}

export interface ContextOptions {
  actorId: string;
  maxTokens?: number;
  memoryTypes?: string[];
}

export interface SummarizeOptions {
  actorId?: string;
  olderThan?: Date;
  skipMostRecent?: number;
  targetCount?: number;
  memoryTypes?: string[];
  keepOriginals?: boolean;
}

export interface PruneStrategy {
  type: "byAge" | "byImportance" | "byCount" | "byType" | "custom";
  maxAge?: number;
  minImportance?: number;
  maxPerActor?: number;
  memoryTypes?: string[];
  predicate?: (memory: Memory) => boolean;
}

// ── Adapters ──

export interface LLMProvider {
  complete(request: {
    system: string;
    user: string;
    model?: string;
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
    maxMemoriesPerActor?: number;
    summarizationThreshold?: number;
    importanceDecayRate?: number;
    embedOnStore?: boolean;
    pruneStrategy?: PruneStrategy;
  };
  hooks?: {
    onMemoryStored?: (memory: Memory) => void;
    onMemoryPruned?: (ids: string[]) => void;
    onSummaryCreated?: (summary: Memory, deletedCount: number) => void;
  };
}

export interface ProcessInput {
  actorId: string;
  content: string;
  memoryType?: import("./types.js").MemoryType;
  importance?: number;
  emotionalValence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
}

export type { ProcessResult };
