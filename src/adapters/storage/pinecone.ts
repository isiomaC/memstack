import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { notFound, storageError } from "../../errors.js";

export type PineconeIndex = {
  upsert(vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]): Promise<void>;
  query(opts: { vector: number[]; topK: number; filter?: Record<string, unknown>; includeMetadata?: boolean; includeValues?: boolean }): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown>; values?: number[] }[] }>;
  fetch(ids: string[]): Promise<{ records: Record<string, { id: string; metadata?: Record<string, unknown>; values?: number[] }> }>;
  deleteOne(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;
  describeIndexStats(): Promise<{ namespaces?: Record<string, { recordCount: number }> }>;
};

export interface PineconeStorageConfig {
  index: PineconeIndex;
  namespace?: string;
  dimension?: number;
}

interface PineconeMetadata {
  actorId: string;
  memoryType: string;
  content: string;
  importance: number;
  emotionalValence: number;
  tags: string[];
  sourceId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  expiresAt?: string;
  _touchedAt: string;
}

const MAX_METADATA_BYTES = 40_000;
const MAX_FETCH_ALL = 10_000;

function estimateMetadataSize(meta: Record<string, unknown>): number {
  return JSON.stringify(meta).length;
}

function truncateContent(meta: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const copy = { ...meta };
  let size = estimateMetadataSize(copy);
  if (size <= maxBytes) return copy;

  const content = copy.content as string;
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    copy.content = content.slice(0, mid) + "...";
    size = estimateMetadataSize(copy);
    if (size <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  copy.content = content.slice(0, lo) + "...";
  return copy;
}

function toPineconeMetadata(memory: MemoryRecord): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    actorId: memory.actorId,
    memoryType: memory.memoryType,
    content: memory.content,
    importance: memory.importance,
    emotionalValence: memory.emotionalValence,
    tags: memory.tags,
    createdAt: memory.createdAt instanceof Date ? memory.createdAt.toISOString() : memory.createdAt,
    _touchedAt: memory._touchedAt instanceof Date ? memory._touchedAt.toISOString() : memory._touchedAt,
  };
  if (memory.sourceId) raw.sourceId = memory.sourceId;
  if (memory.metadata && Object.keys(memory.metadata).length > 0) raw.metadata = memory.metadata;
  if (memory.expiresAt) raw.expiresAt = memory.expiresAt instanceof Date ? memory.expiresAt.toISOString() : memory.expiresAt;

  return truncateContent(raw, MAX_METADATA_BYTES);
}

function fromPineconeRecord(id: string, meta: Record<string, unknown>, values?: number[]): Memory {
  const createdAt = typeof meta.createdAt === "string" ? new Date(meta.createdAt) : new Date();
  const expiresAt = typeof meta.expiresAt === "string" ? new Date(meta.expiresAt) : undefined;
  const content = typeof meta.content === "string" ? meta.content : "";

  return {
    id,
    actorId: String(meta.actorId ?? ""),
    memoryType: (meta.memoryType as MemoryType) ?? "interaction",
    content,
    importance: Number(meta.importance ?? 0.5),
    emotionalValence: Number(meta.emotionalValence ?? 0),
    tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
    embedding: values,
    sourceId: typeof meta.sourceId === "string" ? meta.sourceId : undefined,
    metadata: meta.metadata as Record<string, unknown> | undefined,
    expiresAt,
    createdAt,
  };
}

interface MemoryRecord extends Memory {
  _touchedAt: Date;
}

function toMemoryRecord(memory: Memory, touchedAt?: Date): MemoryRecord {
  return { ...memory, _touchedAt: touchedAt ?? memory.createdAt };
}

export class PineconeStorageAdapter implements StorageProvider {
  private index: PineconeIndex;
  private namespace: string;
  private dimension: number;

  constructor(config: PineconeStorageConfig) {
    this.index = config.index;
    this.namespace = config.namespace ?? "memstack";
    this.dimension = config.dimension ?? 1536;
  }

  async initialize(): Promise<void> {}

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

    const record = toMemoryRecord(memory, now);
    const meta = toPineconeMetadata(record);
    const values = input.embedding ?? new Array(this.dimension).fill(0);

    try {
      await this.index.upsert([{ id, values, metadata: meta }]);
    } catch (err) {
      throw storageError(`Failed to store memory: ${(err as Error).message}`, err);
    }

    return memory;
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const now = new Date();
    const vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[] = [];
    const results: Memory[] = [];

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
      const record = toMemoryRecord(memory, now);
      const meta = toPineconeMetadata(record);
      const values = input.embedding ?? new Array(this.dimension).fill(0);
      vectors.push({ id, values, metadata: meta });
      results.push(memory);
    }

    try {
      await this.index.upsert(vectors);
    } catch (err) {
      throw storageError(`Failed to store batch: ${(err as Error).message}`, err);
    }

    return results;
  }

  async get(id: string): Promise<Memory | null> {
    try {
      const resp = await this.index.fetch([id]);
      const record = resp.records[id];
      if (!record) return null;

      const meta = record.metadata ?? {};
      const expiresAt = typeof meta.expiresAt === "string" ? new Date(meta.expiresAt) : undefined;
      if (expiresAt && expiresAt <= new Date()) return null;

      return fromPineconeRecord(record.id, meta, record.values);
    } catch (err) {
      throw storageError(`Failed to get memory ${id}: ${(err as Error).message}`, err);
    }
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw notFound("Memory", id);

    try {
      await this.index.deleteOne(id);
    } catch (err) {
      throw storageError(`Failed to delete memory ${id}: ${(err as Error).message}`, err);
    }
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const resp = await this.index.fetch(ids);
    const existingIds = Object.keys(resp.records);

    if (existingIds.length === 0) return 0;

    try {
      await this.index.deleteMany(existingIds);
    } catch (err) {
      throw storageError(`Failed to delete memories: ${(err as Error).message}`, err);
    }

    return existingIds.length;
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const topK = query.limit ?? 10;

    const filter: Record<string, unknown> = {};
    if (query.actorId) {
      filter.actorId = { $eq: query.actorId };
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      filter.memoryType = { $in: query.memoryTypes };
    }
    if (query.tags && query.tags.length > 0) {
      filter.tags = { $in: query.tags };
    }

    if (query.strategy === "semantic" && embedding && embedding.length > 0) {
      return this._semanticRetrieve(embedding, topK, filter);
    }

    return this._metadataRetrieve(query, topK, filter);
  }

  private async _semanticRetrieve(
    embedding: number[],
    topK: number,
    filter: Record<string, unknown>,
  ): Promise<Memory[]> {
    try {
      const resp = await this.index.query({
        vector: embedding,
        topK,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        includeMetadata: true,
        includeValues: true,
      });

      const now = new Date();
      return resp.matches
        .map((m) => {
          const meta = m.metadata ?? {};
          return fromPineconeRecord(m.id, meta, m.values);
        })
        .filter((m) => !m.expiresAt || m.expiresAt > now);
    } catch (err) {
      throw storageError(`Failed to retrieve memories: ${(err as Error).message}`, err);
    }
  }

  private async _metadataRetrieve(
    query: MemoryRetrieveQuery,
    topK: number,
    filter: Record<string, unknown>,
  ): Promise<Memory[]> {
    const dummyVector = new Array(this.dimension).fill(0);

    try {
      const resp = await this.index.query({
        vector: dummyVector,
        topK: MAX_FETCH_ALL,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        includeMetadata: true,
        includeValues: true,
      });

      const now = new Date();
      let results = resp.matches
        .map((m) => {
          const meta = m.metadata ?? {};
          return { record: toMemoryRecord(fromPineconeRecord(m.id, meta, m.values)), meta };
        })
        .filter((m) => !m.record.expiresAt || m.record.expiresAt > now);

      if (query.query) {
        const q = query.query.toLowerCase();
        results = results.filter((m) => m.record.content.toLowerCase().includes(q));
      }

      switch (query.strategy) {
        case "recent":
          results.sort((a, b) => b.record._touchedAt.getTime() - a.record._touchedAt.getTime());
          break;
        case "important":
          results.sort((a, b) => b.record.importance - a.record.importance);
          break;
        case "hybrid":
        case "semantic":
        default:
          results.sort(
            (a, b) =>
              b.record.importance - a.record.importance ||
              b.record._touchedAt.getTime() - a.record._touchedAt.getTime(),
          );
          break;
      }

      for (const r of results.slice(0, topK)) {
        r.record._touchedAt = new Date();
      }

      return results.slice(0, topK).map((r) => r.record);
    } catch (err) {
      throw storageError(`Failed to retrieve memories: ${(err as Error).message}`, err);
    }
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    try {
      const stats = await this.index.describeIndexStats();
      const total = stats.namespaces?.[this.namespace]?.recordCount ?? 0;

      if (!filter) return total;

      if (filter.actorId || filter.memoryType || filter.minImportance !== undefined) {
        const dummyVector = new Array(this.dimension).fill(0);
        const pineconeFilter: Record<string, unknown> = {};
        if (filter.actorId) pineconeFilter.actorId = { $eq: filter.actorId };
        if (filter.memoryType) pineconeFilter.memoryType = { $eq: filter.memoryType };

        try {
          const resp = await this.index.query({
            vector: dummyVector,
            topK: total || MAX_FETCH_ALL,
            filter: Object.keys(pineconeFilter).length > 0 ? pineconeFilter : undefined,
            includeMetadata: true,
          });

          const now = new Date();
          return resp.matches.filter((m) => {
            const meta = m.metadata ?? {};
            const memory = fromPineconeRecord(m.id, meta);
            if (memory.expiresAt && memory.expiresAt <= now) return false;
            if (filter.minImportance !== undefined && memory.importance < filter.minImportance) return false;
            return true;
          }).length;
        } catch {
          return total;
        }
      }

      return total;
    } catch (err) {
      throw storageError(`Failed to count memories: ${(err as Error).message}`, err);
    }
  }

  async close(): Promise<void> {}
}
