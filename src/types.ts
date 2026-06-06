// ── Memory ──

export type MemoryType = "interaction" | "summary" | "observation" | "gossip";

export interface Memory {
  id: string;
  actorId: string;
  memoryType: MemoryType;
  content: string;
  importance: number;
  emotionalValence: number;
  tags: string[];
  embedding?: number[];
  sourceId?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
  createdAt: Date;
}

// ── Relationship ──

export type RelationshipStage =
  | "stranger"
  | "acquaintance"
  | "friend"
  | "close_friend"
  | "rival"
  | "nemesis"
  | "romantic";

export interface Relationship {
  actorA: string;
  actorB: string;
  affinity: number;
  trust: number;
  fear: number;
  respect: number;
  stage: RelationshipStage;
  interactionCount: number;
  historySummary?: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ── Quest ──

export type QuestStatus = "offered" | "accepted" | "in_progress" | "completed" | "failed" | "expired";

export interface Quest {
  id: string;
  title: string;
  description: string;
  giverId: string;
  takerId?: string;
  status: QuestStatus;
  objectives: QuestObjective[];
  rewards?: QuestReward;
  timeLimit?: Date;
  prerequisites?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuestObjective {
  index: number;
  description: string;
  isComplete: boolean;
  isOptional: boolean;
  targetCount?: number;
  currentCount?: number;
}

export interface QuestReward {
  gold?: number;
  items?: string[];
  relationshipBonus?: Record<string, number>;
}

// ── Context ──

export interface CompiledContext {
  systemPrompt: string;
  recentMemories: Memory[];
  importantMemories: Memory[];
  relationships: Relationship[];
  activeQuests: Quest[];
  tokenEstimate: number;
}

// ── Process Result ──

export interface ProcessResult {
  memory: Memory;
  relationshipUpdate?: {
    previous: Relationship;
    current: Relationship;
  };
  questTriggers?: Quest[];
  summaryCreated?: Memory;
}

// ── Snapshot ──

export interface MemStackSnapshot {
  version: 1;
  memories: Memory[];
  relationships: Relationship[];
  quests: Quest[];
  exportedAt: string;
}

// ── Health ──

export interface HealthStatus {
  storage: boolean;
  llm: boolean;
  embedding: boolean;
}
