// ── Memory ──

export type MemoryType =
  | "interaction"
  | "summary"
  | "observation"
  | "fact"
  | "reflection"
  | "preference"
  | "decision"
  | "instruction";

/** Where a memory came from. Harness writes store it in `metadata.source`. */
export interface MemorySource {
  /** Harness that wrote the memory, e.g. "claude-code" or "codex". */
  harness: string;
  /** Project ID the memory belongs to. */
  project: string;
  sessionId?: string;
  cwd?: string;
}

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
  messages?: { role: string; content: string }[];
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

// ── Stats ──

export interface MemoryStats {
  total: number;
  expired: number;
  oldest: Date | null;
  newest: Date | null;
  avgImportance: number;
  byType: Record<MemoryType, number>;
  byActor: Record<string, {
    count: number;
    oldest: Date;
    newest: Date;
    avgImportance: number;
  }>;
}
