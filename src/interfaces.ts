import type { Memory, Relationship, Quest, ProcessResult } from "./types.js";

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
  targetId?: string;
  maxTokens?: number;
  includeRelationships?: boolean;
  includeQuests?: boolean;
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
  /** Prune memories older than this */
  maxAge?: number; // ms
  /** Prune memories below this importance */
  minImportance?: number;
  /** Keep at most this many per actor */
  maxPerActor?: number;
  /** Prune only these memory types */
  memoryTypes?: string[];
  /** Custom predicate */
  predicate?: (memory: Memory) => boolean;
}

// ── Relationships ──

export interface RelationshipSetInput {
  affinity?: number;
  trust?: number;
  fear?: number;
  respect?: number;
  stage?: import("./types.js").RelationshipStage;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface RelationshipDeltaInput {
  affinity?: number;
  trust?: number;
  fear?: number;
  respect?: number;
}

export interface RelationshipFindFilter {
  actorId?: string;
  minAffinity?: number;
  maxAffinity?: number;
  stage?: import("./types.js").RelationshipStage;
  tag?: string;
}

export interface RelationshipStore {
  set(actorA: string, actorB: string, data: RelationshipSetInput): Promise<Relationship>;
  updateDeltas(actorA: string, actorB: string, deltas: RelationshipDeltaInput): Promise<Relationship>;
  get(actorA: string, actorB: string): Promise<Relationship | null>;
  getAll(actorId: string): Promise<Relationship[]>;
  find(filter: RelationshipFindFilter): Promise<Relationship[]>;
  delete(actorA: string, actorB: string): Promise<void>;
}

// ── Quests ──

export interface QuestCreateInput {
  title: string;
  description: string;
  giverId: string;
  objectives: Omit<import("./types.js").QuestObjective, "isComplete" | "currentCount">[];
  rewards?: import("./types.js").QuestReward;
  timeLimit?: Date;
  prerequisites?: string[];
  metadata?: Record<string, unknown>;
}

export interface QuestListOptions {
  playerId?: string;
  giverId?: string;
  status?: import("./types.js").QuestStatus | import("./types.js").QuestStatus[];
}

export interface QuestStore {
  create(input: QuestCreateInput): Promise<import("./types.js").Quest>;
  get(id: string): Promise<import("./types.js").Quest | null>;
  list(options?: QuestListOptions): Promise<import("./types.js").Quest[]>;
  accept(id: string, playerId: string): Promise<import("./types.js").Quest>;
  updateObjective(questId: string, objIndex: number, complete: boolean): Promise<import("./types.js").Quest>;
  complete(id: string): Promise<import("./types.js").Quest>;
  fail(id: string): Promise<import("./types.js").Quest>;
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
    onRelationshipChanged?: (rel: Relationship) => void;
    onQuestUpdated?: (quest: Quest) => void;
  };
}

export interface ProcessInput {
  actorId: string;
  content: string;
  memoryType?: import("./types.js").MemoryType;
  importance?: number;
  emotionalValence?: number;
  tags?: string[];
  targetId?: string;
  relationshipDelta?: RelationshipDeltaInput;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
}

export type { ProcessResult };
