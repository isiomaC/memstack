import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { notFound } from "../../errors.js";

type RedisClient = {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string | string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
};

interface MemoryRecord extends Memory {
  _touchedAt: string;
}

export interface RedisStorageConfig {
  redis: RedisClient;
  keyPrefix?: string;
}

export class RedisStorageAdapter implements StorageProvider {
  private redis: RedisClient;
  private prefix: string;
  constructor(config: RedisStorageConfig) {
    this.redis = config.redis;
    this.prefix = config.keyPrefix ?? "memstack";
  }

  async initialize(): Promise<void> {
    // Connection is user-managed; no-op
  }

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
      createdAt: input.createdAt ?? now,
      _touchedAt: now.toISOString(),
    };

    await this.redis.set(this._memKey(memory.id), JSON.stringify(memory));
    await this.redis.sadd(this._actorKey(memory.actorId), memory.id);
    await this.redis.sadd(this._actorsSetKey(), memory.actorId);

    return this._toExternal(memory);
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const results: Memory[] = [];
    const now = new Date();

    for (const input of inputs) {
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
        createdAt: input.createdAt ?? now,
        _touchedAt: now.toISOString(),
      };

      await this.redis.set(this._memKey(memory.id), JSON.stringify(memory));
      await this.redis.sadd(this._actorKey(memory.actorId), memory.id);
      await this.redis.sadd(this._actorsSetKey(), memory.actorId);
      results.push(this._toExternal(memory));
    }

    return results;
  }

  async get(id: string): Promise<Memory | null> {
    const raw = await this.redis.get(this._memKey(id));
    if (!raw) return null;

    const record = JSON.parse(raw) as MemoryRecord;
    if (record.expiresAt && new Date(record.expiresAt) <= new Date()) return null;
    return this._toExternal(record);
  }

  async delete(id: string): Promise<void> {
    const raw = await this.redis.get(this._memKey(id));
    if (!raw) throw notFound("Memory", id);

    const record = JSON.parse(raw) as MemoryRecord;
    await this.redis.del(this._memKey(id));
    await this.redis.srem(this._actorKey(record.actorId), id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    let count = 0;
    const byActor = new Map<string, string[]>();

    for (const id of ids) {
      const raw = await this.redis.get(this._memKey(id));
      if (raw) {
        const record = JSON.parse(raw) as MemoryRecord;
        const list = byActor.get(record.actorId) ?? [];
        list.push(id);
        byActor.set(record.actorId, list);
      }
    }

    for (const [actorId, memIds] of byActor) {
      await this.redis.del(memIds.map((id) => this._memKey(id)));
      await this.redis.srem(this._actorKey(actorId), ...memIds);
      count += memIds.length;
    }

    return count;
  }

  async touch(id: string): Promise<void> {
    const raw = await this.redis.get(this._memKey(id));
    if (!raw) throw notFound("Memory", id);

    const record = JSON.parse(raw) as MemoryRecord;
    record._touchedAt = new Date().toISOString();
    await this.redis.set(this._memKey(id), JSON.stringify(record));
  }

  async retrieve(query: MemoryRetrieveQuery, _embedding?: number[]): Promise<Memory[]> {
    let allRecords: MemoryRecord[] = [];

    if (query.actorId) {
      allRecords = await this._getActorRecords(query.actorId);
    } else {
      const actorIds = await this._listActors();
      for (const actorId of actorIds) {
        const records = await this._getActorRecords(actorId);
        allRecords.push(...records);
      }
    }

    const now = new Date();
    let results = allRecords.filter((r) => !r.expiresAt || new Date(r.expiresAt) > now);

    if (query.memoryTypes && query.memoryTypes.length > 0) {
      results = results.filter((r) => query.memoryTypes!.includes(r.memoryType));
    }
    if (query.tags && query.tags.length > 0) {
      results = results.filter((r) => r.tags?.some((t) => query.tags!.includes(t)));
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter((r) => r.content.toLowerCase().includes(q));
    }

    switch (query.strategy) {
      case "recent":
        results.sort((a, b) => new Date(b._touchedAt).getTime() - new Date(a._touchedAt).getTime());
        break;
      case "important":
        results.sort((a, b) => b.importance - a.importance);
        break;
      case "hybrid":
      case "semantic":
      default:
        results.sort(
          (a, b) =>
            b.importance - a.importance || new Date(b._touchedAt).getTime() - new Date(a._touchedAt).getTime()
        );
        break;
    }

    const nowStr = new Date().toISOString();
    const toTouch = results.slice(0, query.limit ?? 10);
    for (const r of toTouch) {
      r._touchedAt = nowStr;
      await this.redis.set(this._memKey(r.id), JSON.stringify(r));
    }

    const limit = query.limit ?? 10;
    return results.slice(0, limit).map((r) => this._toExternal(r));
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    let allRecords: MemoryRecord[] = [];

    if (filter?.actorId) {
      allRecords = await this._getActorRecords(filter.actorId);
    } else {
      const actorIds = await this._listActors();
      for (const actorId of actorIds) {
        const records = await this._getActorRecords(actorId);
        allRecords.push(...records);
      }
    }

    const now = new Date();
    let results = allRecords.filter((r) => !r.expiresAt || new Date(r.expiresAt) > now);

    if (filter?.memoryType) {
      results = results.filter((r) => r.memoryType === filter.memoryType);
    }
    if (filter?.minImportance !== undefined) {
      results = results.filter((r) => r.importance >= filter.minImportance!);
    }

    return results.length;
  }

  async close(): Promise<void> {
  }

  private _actorsSetKey(): string {
    return `${this.prefix}:actors`;
  }

  private _actorKey(actorId: string): string {
    const safe = actorId.replace(/[^a-zA-Z0-9_\-.,@]/g, "_");
    return `${this.prefix}:a:${safe}`;
  }

  private _memKey(id: string): string {
    return `${this.prefix}:m:${id}`;
  }

  private async _getActorRecords(actorId: string): Promise<MemoryRecord[]> {
    const ids = await this.redis.smembers(this._actorKey(actorId));
    if (ids.length === 0) return [];

    const keys = ids.map((id) => this._memKey(id));
    const raws = await this.redis.mget(...keys);

    const records: MemoryRecord[] = [];
    for (const raw of raws) {
      if (raw) {
        try {
          records.push(JSON.parse(raw) as MemoryRecord);
        } catch {
          // Skip corrupted records
        }
      }
    }

    return records;
  }

  private async _listActors(): Promise<string[]> {
    return this.redis.smembers(this._actorsSetKey());
  }

  private _toExternal(record: MemoryRecord): Memory {
    const { _touchedAt: _, ...rest } = record;
    return {
      ...rest,
      createdAt: new Date(record.createdAt),
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : undefined,
    };
  }
}
