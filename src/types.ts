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

// ── Context ──

export interface CompiledContext {
  systemPrompt: string;
  recentMemories: Memory[];
  importantMemories: Memory[];
  tokenEstimate: number;
}

// ── Process Result ──

export interface ProcessResult {
  memory: Memory;
  summaryCreated?: Memory;
}

// ── Snapshot ──

export interface MemStackSnapshot {
  version: 1;
  memories: Memory[];
  exportedAt: string;
}

// ── Health ──

export interface HealthStatus {
  storage: boolean;
  llm: boolean;
  embedding: boolean;
}
