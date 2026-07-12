import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError } from "../../errors.js";

export interface Mem0StorageConfig {
  mode: "oss" | "cloud";
  apiKey?: string;
  vectorStore?: { provider: string; config: Record<string, unknown> };
  llm?: { provider: string; config: Record<string, unknown> };
  embedder?: { provider: string; config: Record<string, unknown> };
}

type Mem0Client = {
  add(messages: unknown[], options?: { user_id?: string; metadata?: Record<string, unknown> }): Promise<unknown>;
  search(query: string, options?: { user_id?: string; limit?: number; filters?: Record<string, unknown> }): Promise<unknown>;
  get(memory_id: string): Promise<unknown>;
  update(memory_id: string, data: unknown): Promise<unknown>;
  delete(memory_id: string): Promise<void>;
  delete_all(options?: { user_id?: string }): Promise<void>;
  getAll(options?: { user_id?: string; page?: number; page_size?: number }): Promise<unknown>;
};

export class Mem0StorageAdapter implements StorageProvider {
  private client: Mem0Client | null = null;
  private config: Mem0StorageConfig;

  constructor(config?: Mem0StorageConfig) {
    this.config = config ?? { mode: "oss" };
  }

  async initialize(): Promise<void> {
    if (this.config.mode === "cloud") {
      if (!this.config.apiKey) {
        throw storageError("Mem0 cloud mode requires an apiKey");
      }
      // @ts-expect-error - mem0ai is an optional peer dependency
      const mod = await import("mem0ai");
      this.client = new mod.MemoryClient({ apiKey: this.config.apiKey }) as unknown as Mem0Client;
    } else {
      // @ts-expect-error - mem0ai/oss is an optional peer dependency
      const mod = await import("mem0ai/oss");
      this.client = new mod.Memory(this.config) as unknown as Mem0Client;
    }
  }

  private ensureClient(): Mem0Client {
    if (!this.client) throw storageError("Mem0 adapter not initialized. Call initialize() first.");
    return this.client;
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  private _toMemory(raw: unknown, fallbackId: string): Memory {
    const data = raw as Record<string, unknown> | null | undefined;
    if (!data) {
      return {
        id: fallbackId,
        actorId: "",
        memoryType: "interaction",
        content: "",
        importance: 0.5,
        emotionalValence: 0,
        tags: [],
        createdAt: new Date(),
      };
    }
    const meta = data.metadata as Record<string, unknown> | undefined;
    const id = (data.id as string) ?? (data.memory_id as string) ?? fallbackId;
    const content = (data.memory as string) ?? (data.content as string) ?? "";
    const actorId = (data.user_id as string) ?? (data.actor_id as string) ?? "";
    return {
      id,
      actorId,
      memoryType: (data.memory_type as MemoryType) ?? (meta?.memoryType as MemoryType) ?? "interaction",
      content,
      importance: (data.importance as number) ?? (meta?.importance as number) ?? 0.5,
      emotionalValence: (data.emotional_valence as number) ?? (meta?.emotionalValence as number) ?? 0,
      tags: (data.tags as string[]) ?? (meta?.tags as string[]) ?? [],
      embedding: data.embedding as number[] | undefined,
      sourceId: (data.source_id as string) ?? (meta?.sourceId as string),
      metadata: meta ?? (data.metadata as Record<string, unknown> | undefined) ?? {},
      expiresAt: data.expires_at ? new Date(data.expires_at as string) : undefined,
      createdAt: data.created_at ? new Date(data.created_at as string) : new Date(),
    };
  }

  private _extractResults(result: unknown): unknown[] {
    if (Array.isArray(result)) return result;
    const obj = result as Record<string, unknown> | undefined;
    return (obj?.results as unknown[]) ?? (obj?.memories as unknown[]) ?? [];
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const c = this.ensureClient();
    const messages = [{ role: "user", content: input.content }];
    const result = await c.add(messages, {
      user_id: input.actorId,
      metadata: {
        ...input.metadata,
        memoryType: input.memoryType,
        importance: input.importance,
        emotionalValence: input.emotionalValence,
        tags: input.tags,
        sourceId: input.sourceId,
        expiresAt: input.expiresAt?.toISOString(),
      },
    });
    const mem0Result = Array.isArray(result) ? result[0] : result;
    const id = (mem0Result as Record<string, unknown> | null)?.id as string | undefined;
    return {
      id: id ?? input.id ?? this.generateId(),
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
      createdAt: input.createdAt ?? new Date(),
    };
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const input of inputs) {
      results.push(await this.store(input));
    }
    return results;
  }

  async get(id: string): Promise<Memory | null> {
    const c = this.ensureClient();
    const result = await c.get(id);
    if (!result) return null;
    return this._toMemory(result, id);
  }

  async delete(id: string): Promise<void> {
    const c = this.ensureClient();
    await c.delete(id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    const c = this.ensureClient();
    let count = 0;
    for (const id of ids) {
      try {
        await c.delete(id);
        count++;
      } catch {
        // skip failures
      }
    }
    return count;
  }

  async retrieve(query: MemoryRetrieveQuery, _embedding?: number[]): Promise<Memory[]> {
    const c = this.ensureClient();
    let rawResults: unknown[] = [];

    if (query.query) {
      const result = await c.search(query.query, {
        user_id: query.actorId,
        limit: query.limit ?? 10,
        filters: query.memoryTypes ? { memory_type: query.memoryTypes } : undefined,
      });
      rawResults = this._extractResults(result);
    } else {
      const result = await c.getAll({
        user_id: query.actorId,
        page_size: query.limit,
      });
      rawResults = this._extractResults(result);
    }

    let memories = rawResults.map((r) => this._toMemory(r, (r as Record<string, unknown>)?.id as string ?? ""));

    if (query.memoryTypes && query.memoryTypes.length > 0) {
      memories = memories.filter((m) => query.memoryTypes!.includes(m.memoryType));
    }
    if (query.tags && query.tags.length > 0) {
      memories = memories.filter((m) => m.tags.some((t) => query.tags!.includes(t)));
    }

    if (query.limit && query.limit > 0) {
      memories = memories.slice(0, query.limit);
    }

    return memories;
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const c = this.ensureClient();
    const result = await c.getAll({
      user_id: filter?.actorId,
    });
    let memories = this._extractResults(result).map((r) =>
      this._toMemory(r, (r as Record<string, unknown>)?.id as string ?? "")
    );

    if (filter?.memoryType) {
      memories = memories.filter((m) => m.memoryType === filter.memoryType);
    }
    if (filter?.minImportance !== undefined) {
      memories = memories.filter((m) => m.importance >= filter.minImportance!);
    }

    return memories.length;
  }

  async close(): Promise<void> {
    this.client = null;
  }
}
