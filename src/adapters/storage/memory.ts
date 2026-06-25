import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { notFound } from "../../errors.js";

interface MemoryRecord extends Memory {
  _touchedAt: Date;
}

export class InMemoryStorageAdapter implements StorageProvider {
  private memories: Map<string, MemoryRecord> = new Map();

  async initialize(): Promise<void> {}

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const now = new Date();
    const memory: MemoryRecord = {
      id: input.id ?? this.generateId(),
      actorId: input.actorId,
      memoryType: (input.memoryType ?? "interaction") as MemoryType,
      content: input.content,
      importance: input.importance ?? 0.5,
      emotionalValence: input.emotionalValence ?? 0,
      tags: input.tags ?? [],
      embedding: input.embedding,
      sourceId: input.sourceId,
      metadata: input.metadata ?? {},
      expiresAt: input.expiresAt,
      createdAt: now,
      _touchedAt: now,
    };
    this.memories.set(memory.id, memory);
    return memory;
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const input of inputs) {
      results.push(await this.store(input));
    }
    return results;
  }

  async get(id: string): Promise<Memory | null> {
    const memory = this.memories.get(id);
    if (!memory) return null;
    if (memory.expiresAt && memory.expiresAt <= new Date()) {
      this.memories.delete(id);
      return null;
    }
    return memory;
  }

  async delete(id: string): Promise<void> {
    if (!this.memories.has(id)) throw notFound("Memory", id);
    this.memories.delete(id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if (this.memories.has(id)) {
        this.memories.delete(id);
        count++;
      }
    }
    return count;
  }

  async retrieve(query: MemoryRetrieveQuery, _embedding?: number[]): Promise<Memory[]> {
    let results = Array.from(this.memories.values());

    // Filter out expired
    const now = new Date();
    results = results.filter((m) => !m.expiresAt || m.expiresAt > now);

    if (query.actorId) {
      results = results.filter((m) => m.actorId === query.actorId);
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      results = results.filter((m) => query.memoryTypes!.includes(m.memoryType));
    }
    if (query.tags && query.tags.length > 0) {
      results = results.filter((m) => m.tags?.some((t) => query.tags!.includes(t)));
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter((m) => m.content.toLowerCase().includes(q));
    }
    if (query.createdAfter) {
      results = results.filter((m) => m.createdAt >= query.createdAfter!);
    }
    if (query.createdBefore) {
      results = results.filter((m) => m.createdAt <= query.createdBefore!);
    }

    switch (query.strategy) {
      case "recent":
        results.sort((a, b) => b._touchedAt.getTime() - a._touchedAt.getTime());
        break;
      case "important":
        results.sort((a, b) => b.importance - a.importance);
        break;
      case "hybrid":
      case "semantic":
      default:
        results.sort((a, b) => b.importance - a.importance || b._touchedAt.getTime() - a._touchedAt.getTime());
        break;
    }

    // Touch records on retrieval (for recency tracking in context assembly)
    for (const r of results.slice(0, query.limit ?? 10)) {
      r._touchedAt = new Date();
    }

    const limit = query.limit ?? 10;
    return results.slice(0, limit);
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const now = new Date();
    let results = Array.from(this.memories.values())
      .filter((m) => !m.expiresAt || m.expiresAt > now);

    if (filter?.actorId) {
      results = results.filter((m) => m.actorId === filter.actorId);
    }
    if (filter?.memoryType) {
      results = results.filter((m) => m.memoryType === filter.memoryType);
    }
    if (filter?.minImportance !== undefined) {
      results = results.filter((m) => m.importance >= filter.minImportance!);
    }
    return results.length;
  }

  async touch(id: string): Promise<void> {
    const memory = this.memories.get(id);
    if (!memory) throw notFound("Memory", id);
    memory._touchedAt = new Date();
  }

  async close(): Promise<void> {
    this.memories.clear();
  }

  getAllMemories(): Memory[] {
    return Array.from(this.memories.values());
  }
}
