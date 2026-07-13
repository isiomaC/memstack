import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError, notFound } from "../../errors.js";

type MongoCollection = {
  insertOne(doc: Record<string, unknown>): Promise<{ insertedId: string }>;
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, opts?: { upsert?: boolean }): Promise<{ upsertedId?: string }>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  find(filter: Record<string, unknown>): { sort(sort: Record<string, number>): { limit(n: number): { toArray(): Promise<Record<string, unknown>[]> } } };
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
  aggregate(pipeline: Record<string, unknown>[]): { toArray(): Promise<Record<string, unknown>[]> };
};

export interface MongoDBStorageConfig {
  collection: MongoCollection;
  vectorDimensions?: number;
}

interface MongoDoc {
  _id: string;
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

export class MongoDBStorageAdapter implements StorageProvider {
  private collection: MongoCollection;
  private vectorDimensions: number;

  constructor(config: MongoDBStorageConfig) {
    this.collection = config.collection;
    this.vectorDimensions = config.vectorDimensions ?? 1536;
  }

  async initialize(): Promise<void> {
    try {
      const col = this.collection as MongoCollection & { createSearchIndex?: (def: Record<string, unknown>) => Promise<unknown> };
      if (col.createSearchIndex) {
        await col.createSearchIndex({
          name: "memstack_vector",
          definition: {
            mappings: {
              dynamic: false,
              fields: {
                embedding: {
                  type: "knnVector",
                  dimensions: this.vectorDimensions,
                  similarity: "cosine",
                },
              },
            },
          },
        });
      }
    } catch {}
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const now = new Date();
    const memory: Memory = {
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
    };
    await this.collection.insertOne(this.toDoc(memory) as unknown as Record<string, unknown>);
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
    const doc = await this.collection.findOne({ _id: id });
    if (!doc) return null;
    const memory = this.toMemory(doc as unknown as MongoDoc);
    if (memory.expiresAt && memory.expiresAt <= new Date()) return null;
    return memory;
  }

  async delete(id: string): Promise<void> {
    const result = await this.collection.deleteOne({ _id: id });
    if (result.deletedCount === 0) throw notFound("Memory", id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    const result = await this.collection.deleteMany({ _id: { $in: ids } });
    return result.deletedCount;
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    if (query.strategy === "semantic" && embedding) {
      return this.retrieveSemantic(query, embedding);
    }
    return this.retrieveStandard(query);
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const mongoFilter: Record<string, unknown> = {};
    if (filter?.actorId) mongoFilter.actorId = filter.actorId;
    if (filter?.memoryType) mongoFilter.memoryType = filter.memoryType;
    if (filter?.minImportance !== undefined) {
      mongoFilter.importance = { $gte: filter.minImportance };
    }
    return this.collection.countDocuments(mongoFilter);
  }

  async close(): Promise<void> {}

  private async retrieveStandard(query: MemoryRetrieveQuery): Promise<Memory[]> {
    const filter: Record<string, unknown> = {};
    if (query.actorId) filter.actorId = query.actorId;

    if (query.tags && query.tags.length > 0) {
      filter.tags = { $in: query.tags };
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      filter.memoryType = { $in: query.memoryTypes };
    }

    let sortObj: Record<string, number>;
    switch (query.strategy) {
      case "recent":
        sortObj = { createdAt: -1 };
        break;
      case "important":
        sortObj = { importance: -1 };
        break;
      default:
        sortObj = { importance: -1, createdAt: -1 };
        break;
    }

    const docs = await this.collection
      .find(filter)
      .sort(sortObj)
      .limit(10000)
      .toArray();

    const now = new Date();
    let results = docs
      .map((doc) => this.toMemory(doc as unknown as MongoDoc))
      .filter((m) => !m.expiresAt || m.expiresAt > now);

    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter((m) => m.content.toLowerCase().includes(q));
    }

    return results.slice(0, query.limit ?? 10);
  }

  private async retrieveSemantic(query: MemoryRetrieveQuery, embedding: number[]): Promise<Memory[]> {
    try {
      const filter: Record<string, unknown> = {};
      if (query.actorId) filter.actorId = query.actorId;

      const pipeline: Record<string, unknown>[] = [
        {
          $vectorSearch: {
            index: "memstack_vector",
            path: "embedding",
            queryVector: embedding,
            numCandidates: 100,
            limit: query.limit ?? 10,
            filter: filter,
          },
        },
      ];

      const docs = await this.collection.aggregate(pipeline).toArray();
      const now = new Date();
      return docs
        .map((doc) => this.toMemory(doc as unknown as MongoDoc))
        .filter((m) => !m.expiresAt || m.expiresAt > now);
    } catch {
      return this.retrieveStandard(query);
    }
  }

  private toMemory(doc: MongoDoc): Memory {
    return {
      id: doc._id,
      actorId: doc.actorId,
      memoryType: doc.memoryType,
      content: doc.content,
      importance: doc.importance,
      emotionalValence: doc.emotionalValence,
      tags: doc.tags,
      embedding: doc.embedding,
      sourceId: doc.sourceId,
      metadata: doc.metadata,
      expiresAt: doc.expiresAt,
      createdAt: doc.createdAt,
    };
  }

  private toDoc(memory: Memory): MongoDoc {
    return {
      _id: memory.id,
      actorId: memory.actorId,
      memoryType: memory.memoryType,
      content: memory.content,
      importance: memory.importance,
      emotionalValence: memory.emotionalValence,
      tags: memory.tags,
      embedding: memory.embedding,
      sourceId: memory.sourceId,
      metadata: memory.metadata,
      expiresAt: memory.expiresAt,
      createdAt: memory.createdAt,
    };
  }
}
