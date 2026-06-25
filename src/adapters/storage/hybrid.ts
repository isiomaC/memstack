import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import type { Memory } from "../../types.js";
export interface HybridStorageConfig {
  cache: StorageProvider;
  durable: StorageProvider;
  writeBoth?: boolean;
  readFromCache?: boolean;
  syncOnInit?: boolean;
}

export class HybridStorageAdapter implements StorageProvider {
  private cache: StorageProvider;
  private durable: StorageProvider;
  private writeBoth: boolean;
  private readFromCache: boolean;
  private syncOnInit: boolean;

  constructor(config: HybridStorageConfig) {
    this.cache = config.cache;
    this.durable = config.durable;
    this.writeBoth = config.writeBoth ?? true;
    this.readFromCache = config.readFromCache ?? true;
    this.syncOnInit = config.syncOnInit ?? false;
  }

  async initialize(): Promise<void> {
    await Promise.all([this.cache.initialize(), this.durable.initialize()]);

    if (this.syncOnInit) {
      const results = await this.durable.retrieve({ limit: 100000 });
      if (results.length > 0) {
        await this.cache.storeBatch(results.map((m) => ({
          actorId: m.actorId,
          content: m.content,
          memoryType: m.memoryType,
          importance: m.importance,
          emotionalValence: m.emotionalValence,
          tags: m.tags,
          embedding: m.embedding,
          sourceId: m.sourceId,
          metadata: m.metadata,
          expiresAt: m.expiresAt,
          id: m.id,
        }))).catch(() => {});
      }
    }
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const result = await this.durable.store(input);

    if (this.writeBoth) {
      try {
        await this.cache.store({ ...input, id: result.id });
      } catch {}
    }

    return result;
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const results = await this.durable.storeBatch(inputs);

    if (this.writeBoth) {
      const cacheInputs: MemoryStoreInput[] = results.map((r, i) => ({
        ...inputs[i],
        id: r.id,
      }));
      try {
        await this.cache.storeBatch(cacheInputs);
      } catch {}
    }

    return results;
  }

  async get(id: string): Promise<Memory | null> {
    if (this.readFromCache) {
      const cached = await this.cache.get(id);
      if (cached) return cached;

      const result = await this.durable.get(id);
      if (result) {
        try { await this.cache.store({
          actorId: result.actorId,
          content: result.content,
          memoryType: result.memoryType,
          importance: result.importance,
          emotionalValence: result.emotionalValence,
          tags: result.tags,
          embedding: result.embedding,
          sourceId: result.sourceId,
          metadata: result.metadata,
          expiresAt: result.expiresAt,
          id: result.id,
        }); } catch {}
      }
      return result;
    }

    return this.durable.get(id);
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    if (this.readFromCache) {
      const cached = await this.cache.retrieve(query, embedding);
      if (cached.length > 0) return cached;

      const results = await this.durable.retrieve(query, embedding);
      if (results.length > 0) {
        const inputs: MemoryStoreInput[] = results.map((r) => ({
          actorId: r.actorId,
          content: r.content,
          memoryType: r.memoryType,
          importance: r.importance,
          emotionalValence: r.emotionalValence,
          tags: r.tags,
          embedding: r.embedding,
          sourceId: r.sourceId,
          metadata: r.metadata,
          expiresAt: r.expiresAt,
          id: r.id,
        }));
        try { await this.cache.storeBatch(inputs); } catch {}
      }
      return results;
    }

    return this.durable.retrieve(query, embedding);
  }

  async delete(id: string): Promise<void> {
    const results = await Promise.allSettled([
      this.cache.delete(id),
      this.durable.delete(id),
    ]);

    const durableResult = results[1];
    if (durableResult.status === "rejected") {
      throw durableResult.reason;
    }
  }

  async deleteMany(ids: string[]): Promise<number> {
    const [cacheResult, durableCount] = await Promise.all([
      this.cache.deleteMany(ids).catch(() => 0),
      this.durable.deleteMany(ids),
    ]);

    return durableCount;
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    return this.durable.count(filter);
  }

  async touch(id: string): Promise<void> {
    if (this.durable.touch) {
      await this.durable.touch(id);
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.cache.close(), this.durable.close()]);
  }
}
