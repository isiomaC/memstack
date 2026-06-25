import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { notFound, storageError, configError } from "../../errors.js";

type UpstashRedis = {
  set(key: string, value: string): Promise<string>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
};

type UpstashVector = {
  upsert(vectors: { id: string; vector: number[]; metadata?: Record<string, unknown> }[]): Promise<string>;
  query(opts: { vector: number[]; topK: number; includeMetadata?: boolean; filter?: string }): Promise<{ id: string; score: number; metadata?: Record<string, unknown> }[]>;
  fetch(ids: string[]): Promise<{ id: string; vector?: number[]; metadata?: Record<string, unknown> }[]>;
  delete(ids: string[]): Promise<string>;
  info(): Promise<{ vectorCount: number; dimension: number }>;
};

export interface UpstashStorageConfig {
  mode: "redis" | "vector";
  url: string;
  token: string;
  keyPrefix?: string;
  dimensions?: number;
  namespace?: string;
}

export class UpstashStorageAdapter implements StorageProvider {
  private mode: "redis" | "vector";
  private config: UpstashStorageConfig;
  private redis: UpstashRedis | null = null;
  private vector: UpstashVector | null = null;
  private prefix: string;
  private dimensions: number;

  constructor(config: UpstashStorageConfig) {
    if (config.mode !== "redis" && config.mode !== "vector") {
      throw configError(`Invalid mode: ${config.mode}. Must be "redis" or "vector".`);
    }
    if (!config.url || !config.token) {
      throw configError("url and token are required for UpstashStorageAdapter");
    }
    this.mode = config.mode;
    this.config = config;
    this.prefix = config.keyPrefix ?? "memstack:";
    this.dimensions = config.dimensions ?? 1536;
  }

  async initialize(): Promise<void> {
    if (this.mode === "redis") {
      // @ts-expect-error - @upstash/redis is an optional peer dependency
      const { Redis } = await import("@upstash/redis");
      this.redis = new Redis({ url: this.config.url, token: this.config.token }) as unknown as UpstashRedis;
    } else {
      // @ts-expect-error - @upstash/vector is an optional peer dependency
      const { Index } = await import("@upstash/vector");
      this.vector = new Index({ url: this.config.url, token: this.config.token }) as unknown as UpstashVector;
    }
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const now = new Date();
    const id = input.id ?? this.generateId();
    const memory: Memory = {
      id,
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
    };

    if (this.mode === "redis") {
      await this.redis!.set(this._key(id), JSON.stringify(memory));
      await this.redis!.sadd(this._actorKey(memory.actorId), id);
      await this.redis!.sadd(this._actorsSetKey(), memory.actorId);
    } else {
      const meta = this._toVectorMetadata(memory);
      const vector = input.embedding ?? new Array(this.dimensions).fill(0);
      try {
        await this.vector!.upsert([{ id, vector, metadata: meta }]);
      } catch (err) {
        throw storageError(`Failed to store memory: ${(err as Error).message}`, err);
      }
    }

    return memory;
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    if (inputs.length === 0) return [];

    const results: Memory[] = [];
    const now = new Date();

    if (this.mode === "redis") {
      for (const input of inputs) {
        const id = input.id ?? this.generateId();
        const memory: Memory = {
          id,
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
        };
        await this.redis!.set(this._key(id), JSON.stringify(memory));
        await this.redis!.sadd(this._actorKey(memory.actorId), id);
        await this.redis!.sadd(this._actorsSetKey(), memory.actorId);
        results.push(memory);
      }
      return results;
    }

    const vectors: { id: string; vector: number[]; metadata?: Record<string, unknown> }[] = [];
    for (const input of inputs) {
      const id = input.id ?? this.generateId();
      const memory: Memory = {
        id,
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
      };
      const meta = this._toVectorMetadata(memory);
      const vector = input.embedding ?? new Array(this.dimensions).fill(0);
      vectors.push({ id, vector, metadata: meta });
      results.push(memory);
    }

    try {
      await this.vector!.upsert(vectors);
    } catch (err) {
      throw storageError(`Failed to store batch: ${(err as Error).message}`, err);
    }

    return results;
  }

  async get(id: string): Promise<Memory | null> {
    if (this.mode === "redis") {
      const raw = await this.redis!.get(this._key(id));
      if (!raw) return null;

      const mem = this._deserializeMemory(JSON.parse(raw) as Memory);
      if (mem.expiresAt && mem.expiresAt <= new Date()) return null;
      return mem;
    }

    const results = await this.vector!.fetch([id]);
    if (results.length === 0) return null;

    const record = results[0];
    const mem = this._fromVectorRecord(record.id, record.metadata ?? {});
    if (mem.expiresAt && mem.expiresAt <= new Date()) return null;
    return mem;
  }

  async delete(id: string): Promise<void> {
    if (this.mode === "redis") {
      const raw = await this.redis!.get(this._key(id));
      if (!raw) throw notFound("Memory", id);
      const mem = JSON.parse(raw) as Memory;
      await this.redis!.del(this._key(id));
      await this.redis!.srem(this._actorKey(mem.actorId), id);
      return;
    }

    const results = await this.vector!.fetch([id]);
    if (results.length === 0) throw notFound("Memory", id);
    await this.vector!.delete([id]);
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    if (this.mode === "redis") {
      let count = 0;
      const byActor = new Map<string, string[]>();

      for (const id of ids) {
        const raw = await this.redis!.get(this._key(id));
        if (raw) {
          const mem = JSON.parse(raw) as Memory;
          const list = byActor.get(mem.actorId) ?? [];
          list.push(id);
          byActor.set(mem.actorId, list);
        }
      }

      for (const [actorId, memIds] of byActor) {
        for (const id of memIds) {
          await this.redis!.del(this._key(id));
        }
        await this.redis!.srem(this._actorKey(actorId), ...memIds);
        count += memIds.length;
      }
      return count;
    }

    const results = await this.vector!.fetch(ids);
    const existingIds = results.map((r) => r.id);
    if (existingIds.length === 0) return 0;
    await this.vector!.delete(existingIds);
    return existingIds.length;
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    if (this.mode === "redis") {
      return this._redisRetrieve(query);
    }
    return this._vectorRetrieve(query, embedding);
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    if (this.mode === "redis") {
      return this._redisCount(filter);
    }
    return this._vectorCount(filter);
  }

  async close(): Promise<void> {}

  private _key(id: string): string {
    return `${this.prefix}${id}`;
  }

  private _actorsSetKey(): string {
    return `${this.prefix}actors`;
  }

  private _actorKey(actorId: string): string {
    const safe = actorId.replace(/[^a-zA-Z0-9_\-.,@]/g, "_");
    return `${this.prefix}a:${safe}`;
  }

  private _deserializeMemory(raw: Memory): Memory {
    return {
      ...raw,
      createdAt: new Date(raw.createdAt),
      expiresAt: raw.expiresAt ? new Date(raw.expiresAt) : undefined,
    };
  }

  private async _redisRetrieve(query: MemoryRetrieveQuery): Promise<Memory[]> {
    const client = this.redis!;
    const now = new Date();
    let memories: Memory[] = [];

    if (query.actorId) {
      const ids = await client.smembers(this._actorKey(query.actorId));
      if (ids.length === 0) return [];
      const keys = ids.map((id) => this._key(id));
      const raws = await client.mget(...keys);
      for (const raw of raws) {
        if (!raw) continue;
        try {
          const mem = this._deserializeMemory(JSON.parse(raw) as Memory);
          if (mem.expiresAt && mem.expiresAt <= now) continue;
          memories.push(mem);
        } catch {
          continue;
        }
      }
    } else {
      const actorIds = await client.smembers(this._actorsSetKey());
      for (const actorId of actorIds) {
        const ids = await client.smembers(this._actorKey(actorId));
        if (ids.length === 0) continue;
        const keys = ids.map((id) => this._key(id));
        const raws = await client.mget(...keys);
        for (const raw of raws) {
          if (!raw) continue;
          try {
            const mem = this._deserializeMemory(JSON.parse(raw) as Memory);
            if (mem.expiresAt && mem.expiresAt <= now) continue;
            memories.push(mem);
          } catch {
            continue;
          }
        }
      }
    }

    if (query.memoryTypes && query.memoryTypes.length > 0) {
      memories = memories.filter((m) => query.memoryTypes!.includes(m.memoryType));
    }
    if (query.tags && query.tags.length > 0) {
      memories = memories.filter((m) => m.tags?.some((t) => query.tags!.includes(t)));
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      memories = memories.filter((m) => m.content.toLowerCase().includes(q));
    }

    switch (query.strategy) {
      case "recent":
        memories.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        break;
      case "important":
        memories.sort((a, b) => b.importance - a.importance);
        break;
      case "hybrid":
      case "semantic":
      default:
        memories.sort(
          (a, b) =>
            b.importance - a.importance || b.createdAt.getTime() - a.createdAt.getTime()
        );
        break;
    }

    return memories.slice(0, query.limit ?? 10);
  }

  private async _vectorRetrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const topK = query.limit ?? 10;
    const filterStr = query.actorId ? `actorId = "${query.actorId}"` : undefined;

    if (query.strategy === "semantic" && embedding && embedding.length > 0) {
      const results = await this.vector!.query({
        vector: embedding,
        topK,
        includeMetadata: true,
        filter: filterStr,
      });

      const now = new Date();
      return results
        .map((r) => this._fromVectorRecord(r.id, r.metadata ?? {}))
        .filter((m) => !m.expiresAt || m.expiresAt > now);
    }

    const dummyVector = new Array(this.dimensions).fill(0);
    const allResults = await this.vector!.query({
      vector: dummyVector,
      topK: 10000,
      includeMetadata: true,
      filter: filterStr,
    });

    const now = new Date();
    let memories = allResults
      .map((r) => this._fromVectorRecord(r.id, r.metadata ?? {}))
      .filter((m) => !m.expiresAt || m.expiresAt > now);

    if (query.memoryTypes && query.memoryTypes.length > 0) {
      memories = memories.filter((m) => query.memoryTypes!.includes(m.memoryType));
    }
    if (query.tags && query.tags.length > 0) {
      memories = memories.filter((m) => m.tags?.some((t) => query.tags!.includes(t)));
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      memories = memories.filter((m) => m.content.toLowerCase().includes(q));
    }

    switch (query.strategy) {
      case "recent":
        memories.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        break;
      case "important":
        memories.sort((a, b) => b.importance - a.importance);
        break;
      case "hybrid":
      case "semantic":
      default:
        memories.sort(
          (a, b) =>
            b.importance - a.importance || b.createdAt.getTime() - a.createdAt.getTime()
        );
        break;
    }

    return memories.slice(0, topK);
  }

  private async _redisCount(filter?: MemoryCountFilter): Promise<number> {
    const client = this.redis!;
    const now = new Date();

    if (filter?.actorId) {
      const ids = await client.smembers(this._actorKey(filter.actorId));
      if (ids.length === 0) return 0;

      const keys = ids.map((id) => this._key(id));
      const raws = await client.mget(...keys);
      let count = 0;
      for (const raw of raws) {
        if (!raw) continue;
        try {
          const mem = this._deserializeMemory(JSON.parse(raw) as Memory);
          if (mem.expiresAt && mem.expiresAt <= now) continue;
          if (filter?.memoryType && mem.memoryType !== filter.memoryType) continue;
          if (filter?.minImportance !== undefined && mem.importance < filter.minImportance) continue;
          count++;
        } catch {
          continue;
        }
      }
      return count;
    }

    const actorIds = await client.smembers(this._actorsSetKey());
    let count = 0;
    for (const actorId of actorIds) {
      const ids = await client.smembers(this._actorKey(actorId));
      if (ids.length === 0) continue;
      const keys = ids.map((id) => this._key(id));
      const raws = await client.mget(...keys);
      for (const raw of raws) {
        if (!raw) continue;
        try {
          const mem = this._deserializeMemory(JSON.parse(raw) as Memory);
          if (mem.expiresAt && mem.expiresAt <= now) continue;
          if (filter?.memoryType && mem.memoryType !== filter.memoryType) continue;
          if (filter?.minImportance !== undefined && mem.importance < filter.minImportance) continue;
          count++;
        } catch {
          continue;
        }
      }
    }
    return count;
  }

  private async _vectorCount(filter?: MemoryCountFilter): Promise<number> {
    const info = await this.vector!.info();
    if (!filter) return info.vectorCount;

    const dummyVector = new Array(this.dimensions).fill(0);
    const filterStr = filter.actorId ? `actorId = "${filter.actorId}"` : undefined;

    const results = await this.vector!.query({
      vector: dummyVector,
      topK: info.vectorCount || 10000,
      includeMetadata: true,
      filter: filterStr,
    });

    const now = new Date();
    return results.filter((r) => {
      const meta = r.metadata ?? {};
      if (filter.memoryType && meta.memoryType !== filter.memoryType) return false;
      if (filter.minImportance !== undefined && Number(meta.importance ?? 0) < filter.minImportance) return false;
      const expiresAt = meta.expiresAt ? new Date(meta.expiresAt as string) : undefined;
      if (expiresAt && expiresAt <= now) return false;
      return true;
    }).length;
  }

  private _toVectorMetadata(memory: Memory): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      actorId: memory.actorId,
      memoryType: memory.memoryType,
      content: memory.content,
      importance: memory.importance,
      emotionalValence: memory.emotionalValence,
      tags: memory.tags,
      createdAt: memory.createdAt.toISOString(),
    };
    if (memory.sourceId) meta.sourceId = memory.sourceId;
    if (memory.metadata && Object.keys(memory.metadata).length > 0) meta.extraMetadata = JSON.stringify(memory.metadata);
    if (memory.expiresAt) meta.expiresAt = memory.expiresAt.toISOString();
    return meta;
  }

  private _fromVectorRecord(id: string, meta: Record<string, unknown>): Memory {
    let extraMetadata: Record<string, unknown> | undefined;
    if (typeof meta.extraMetadata === "string") {
      try {
        extraMetadata = JSON.parse(meta.extraMetadata) as Record<string, unknown>;
      } catch {
        extraMetadata = undefined;
      }
    }

    return {
      id,
      actorId: String(meta.actorId ?? ""),
      memoryType: (meta.memoryType as MemoryType) ?? "interaction",
      content: String(meta.content ?? ""),
      importance: Number(meta.importance ?? 0.5),
      emotionalValence: Number(meta.emotionalValence ?? 0),
      tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
      embedding: undefined,
      sourceId: typeof meta.sourceId === "string" ? meta.sourceId : undefined,
      metadata: extraMetadata ?? {},
      createdAt: typeof meta.createdAt === "string" ? new Date(meta.createdAt) : new Date(),
      expiresAt: typeof meta.expiresAt === "string" ? new Date(meta.expiresAt) : undefined,
    };
  }
}
