import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError, notFound } from "../../errors.js";

interface MemoryRecord extends Memory {
  _touchedAt: Date;
}

export class InMemoryStorage implements StorageProvider {
  private memories: Map<string, MemoryRecord> = new Map();

  async initialize(): Promise<void> {}

  generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `mem_${timestamp}_${random}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    try {
      const now = new Date();
      const memory: MemoryRecord = {
        id: this.generateId(),
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
    } catch (err) {
      throw storageError("Failed to store memory", err);
    }
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
    this.touchRecord(memory);
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

    if (query.actorId) {
      results = results.filter((m) => m.actorId === query.actorId);
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      results = results.filter((m) => query.memoryTypes!.includes(m.memoryType));
    }
    if (query.tags && query.tags.length > 0) {
      results = results.filter((m) => query.tags?.some((t) => query.tags!.includes(t)));
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter((m) => m.content.toLowerCase().includes(q));
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
        // In-memory: sort by importance then recency
        results.sort((a, b) => b.importance - a.importance || b._touchedAt.getTime() - a._touchedAt.getTime());
        break;
    }

    const limit = query.limit ?? 10;
    return results.slice(0, limit);
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    let results = Array.from(this.memories.values());
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

  async close(): Promise<void> {
    this.memories.clear();
  }

  getAllMemories(): Memory[] {
    return Array.from(this.memories.values());
  }

  private touchRecord(memory: MemoryRecord): void {
    memory._touchedAt = new Date();
  }
}
