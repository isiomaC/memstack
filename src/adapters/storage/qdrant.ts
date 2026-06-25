import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError, notFound } from "../../errors.js";

type QdrantClient = {
  createCollection(name: string, config: { vectors: { size: number; distance: string } }): Promise<unknown>;
  getCollection(name: string): Promise<unknown>;
  upsert(name: string, opts: { points: { id: string; vector: number[]; payload: Record<string, unknown> }[] }): Promise<unknown>;
  retrieve(name: string, opts: { ids: string[] }): Promise<unknown[]>;
  search(name: string, opts: { vector: number[]; limit: number; filter?: { must: unknown[] } }): Promise<unknown[]>;
  delete(name: string, opts: { points: string[] }): Promise<unknown>;
  count(name: string, opts?: { filter?: { must: unknown[] } }): Promise<{ count: number }>;
  scroll(name: string, opts?: { filter?: { must: unknown[] }; limit?: number }): Promise<{ points: unknown[] }>;
};

export interface QdrantStorageConfig {
  client: QdrantClient;
  collectionName?: string;
  vectorSize?: number;
}

interface QdrantPoint {
  id: string;
  payload: Record<string, unknown>;
  vector?: number[];
}

export class QdrantStorageAdapter implements StorageProvider {
  private client: QdrantClient;
  private collectionName: string;
  private vectorSize: number;
  private _idToQdrant = new Map<string, string>();

  constructor(config: QdrantStorageConfig) {
    this.client = config.client;
    this.collectionName = config.collectionName ?? "memstack";
    this.vectorSize = config.vectorSize ?? 1536;
  }

  async initialize(): Promise<void> {
    try {
      await this.client.getCollection(this.collectionName);
    } catch {
      await this.client.createCollection(this.collectionName, {
        vectors: { size: this.vectorSize, distance: "Cosine" },
      });
    }
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
      createdAt: now,
    };

    const qdrantId = crypto.randomUUID();
    await this.client.upsert(this.collectionName, {
      points: [
        {
          id: qdrantId,
          vector: input.embedding ?? new Array(this.vectorSize).fill(0),
          payload: this._toPayload(memory),
        },
      ],
    });

    this._idToQdrant.set(memory.id, qdrantId);
    return memory;
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const results: Memory[] = [];
    const now = new Date();
    const points: { id: string; vector: number[]; payload: Record<string, unknown> }[] = [];

    for (const input of inputs) {
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
        createdAt: now,
      };
      results.push(memory);
      const qid = crypto.randomUUID();
      points.push({
        id: qid,
        vector: input.embedding ?? new Array(this.vectorSize).fill(0),
        payload: this._toPayload(memory),
      });
      this._idToQdrant.set(memory.id, qid);
    }

    await this.client.upsert(this.collectionName, { points });
    return results;
  }

  async get(id: string): Promise<Memory | null> {
    const qdrantId = this._idToQdrant.get(id);
    if (qdrantId) {
      const points = await this.client.retrieve(this.collectionName, { ids: [qdrantId] });
      if (points && points.length > 0) {
        const point = points[0] as QdrantPoint;
        if (point.payload.expiresAt && new Date(point.payload.expiresAt as string) <= new Date()) return null;
        return this._fromPoint(point);
      }
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    const qdrantId = this._idToQdrant.get(id);
    if (!qdrantId) throw notFound("Memory", id);
    await this.client.delete(this.collectionName, { points: [qdrantId] });
    this._idToQdrant.delete(id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    const qdrantIds: string[] = [];
    for (const id of ids) {
      const qid = this._idToQdrant.get(id);
      if (qid) { qdrantIds.push(qid); this._idToQdrant.delete(id); }
    }
    if (qdrantIds.length === 0) return 0;
    await this.client.delete(this.collectionName, { points: qdrantIds });
    return qdrantIds.length;
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const must: unknown[] = [];

    if (query.actorId) {
      must.push({ key: "actorId", match: { value: query.actorId } });
    }

    if (query.memoryTypes && query.memoryTypes.length > 0) {
      must.push({ key: "memoryType", match: { any: query.memoryTypes } });
    }

    if (query.tags && query.tags.length > 0) {
      must.push({ key: "tags", match: { any: query.tags } });
    }

    const filter = must.length > 0 ? { must } : undefined;
    const limit = query.limit ?? 10;

    if (query.strategy === "semantic" || query.strategy === "hybrid") {
      const vector = embedding ?? new Array(this.vectorSize).fill(0);
      const results = await this.client.search(this.collectionName, {
        vector,
        limit,
        filter: filter as { must: unknown[] } | undefined,
      });
      const points = results as QdrantPoint[];
      return points.map((p) => this._fromPoint(p));
    }

    const vector = new Array(this.vectorSize).fill(0);
    const results = await this.client.search(this.collectionName, {
      vector,
      limit: 10000,
      filter: filter as { must: unknown[] } | undefined,
    });
    let points = results as QdrantPoint[];

    switch (query.strategy) {
      case "recent":
        points.sort((a, b) => {
          const aTime = new Date(a.payload.createdAt as string).getTime();
          const bTime = new Date(b.payload.createdAt as string).getTime();
          return bTime - aTime;
        });
        break;
      case "important":
        points.sort((a, b) => (b.payload.importance as number) - (a.payload.importance as number));
        break;
    }

    return points.slice(0, limit).map((p) => this._fromPoint(p));
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const must: unknown[] = [];

    if (filter?.actorId) {
      must.push({ key: "actorId", match: { value: filter.actorId } });
    }

    if (filter?.memoryType) {
      must.push({ key: "memoryType", match: { value: filter.memoryType } });
    }

    if (filter?.minImportance !== undefined) {
      must.push({ key: "importance", range: { gte: filter.minImportance } });
    }

    const filterObj = must.length > 0 ? { must } : undefined;
    const result = await this.client.count(this.collectionName, filterObj ? { filter: filterObj } : undefined);
    return result.count;
  }

  async close(): Promise<void> {}

  private _toPayload(memory: Memory): Record<string, unknown> {
    return {
      _id: memory.id,
      actorId: memory.actorId,
      memoryType: memory.memoryType,
      importance: memory.importance,
      emotionalValence: memory.emotionalValence,
      tags: memory.tags,
      content: memory.content,
      metadata: memory.metadata ?? {},
      createdAt: memory.createdAt.toISOString(),
      sourceId: memory.sourceId ?? null,
      expiresAt: memory.expiresAt?.toISOString() ?? null,
    };
  }

  private _fromPoint(point: QdrantPoint): Memory {
    const p = point.payload;
    return {
      id: (p._id as string) ?? point.id,
      actorId: p.actorId as string,
      memoryType: p.memoryType as MemoryType,
      content: p.content as string,
      importance: p.importance as number,
      emotionalValence: (p.emotionalValence as number) ?? 0,
      tags: (p.tags as string[]) ?? [],
      embedding: point.vector as number[] | undefined,
      sourceId: (p.sourceId as string | undefined) ?? undefined,
      metadata: (p.metadata as Record<string, unknown>) ?? {},
      expiresAt: p.expiresAt ? new Date(p.expiresAt as string) : undefined,
      createdAt: new Date(p.createdAt as string),
    };
  }
}
