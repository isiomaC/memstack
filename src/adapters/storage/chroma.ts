import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError } from "../../errors.js";

type ChromaCollection = {
  add(opts: { ids: string[]; metadatas?: Record<string, unknown>[]; documents?: string[]; embeddings?: number[][] }): Promise<void>;
  get(opts: { ids?: string[]; where?: Record<string, unknown>; limit?: number; include?: string[] }): Promise<{ ids: string[]; metadatas: (Record<string, unknown> | null)[]; documents: (string | null)[]; embeddings: (number[] | null)[] }>;
  query(opts: { queryEmbeddings?: number[][]; queryTexts?: string[]; nResults?: number; where?: Record<string, unknown>; include?: string[] }): Promise<{ ids: string[][]; metadatas: (Record<string, unknown> | null)[][]; documents: (string | null)[][]; distances: number[][] }>;
  delete(opts: { ids?: string[]; where?: Record<string, unknown> }): Promise<void>;
  modify(name: string, metadata: unknown): Promise<void>;
  count(): Promise<number>;
  peek(limit?: number): Promise<{ ids: string[]; metadatas: (Record<string, unknown> | null)[]; documents: (string | null)[]; embeddings: (number[] | null)[] }>;
};

export interface ChromaStorageConfig {
  collection: ChromaCollection;
}

export class ChromaStorageAdapter implements StorageProvider {
  private collection: ChromaCollection;

  constructor(config: ChromaStorageConfig) {
    this.collection = config.collection;
  }

  async initialize(): Promise<void> {}

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

    try {
      await this.collection.add({
        ids: [memory.id],
        metadatas: [this._serializeMetadata(memory)],
        documents: [memory.content],
        embeddings: memory.embedding ? [memory.embedding] : undefined,
      });
    } catch (err) {
      throw storageError(`Failed to store memory: ${(err as Error).message}`, err);
    }

    return memory;
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const now = new Date();
    const memories: Memory[] = [];
    const ids: string[] = [];
    const metadatas: Record<string, unknown>[] = [];
    const documents: string[] = [];
    const embeddings: number[][] = [];

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
      memories.push(memory);
      ids.push(memory.id);
      metadatas.push(this._serializeMetadata(memory));
      documents.push(memory.content);
      if (memory.embedding) embeddings.push(memory.embedding);
    }

    if (memories.length === 0) return [];

    try {
      await this.collection.add({
        ids,
        metadatas,
        documents,
        embeddings: embeddings.length > 0 ? embeddings : undefined,
      });
    } catch (err) {
      throw storageError(`Failed to store batch: ${(err as Error).message}`, err);
    }

    return memories;
  }

  async get(id: string): Promise<Memory | null> {
    try {
      const result = await this.collection.get({ ids: [id] });
      if (result.ids.length === 0) return null;
      const memory = this._toMemory(
        result.ids[0],
        result.metadatas[0],
        result.documents[0],
        result.embeddings[0]
      );
      if (memory.expiresAt && memory.expiresAt <= new Date()) return null;
      return memory;
    } catch (err) {
      throw storageError(`Failed to get memory: ${(err as Error).message}`, err);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.collection.delete({ ids: [id] });
    } catch (err) {
      throw storageError(`Failed to delete memory: ${(err as Error).message}`, err);
    }
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    try {
      const existing = await this.collection.get({ ids });
      const count = existing.ids.length;
      if (count > 0) {
        await this.collection.delete({ ids: existing.ids });
      }
      return count;
    } catch (err) {
      throw storageError(`Failed to delete memories: ${(err as Error).message}`, err);
    }
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const limit = query.limit ?? 10;
    const where = query.actorId ? { actorId: { $eq: query.actorId } } : undefined;

    try {
      if (query.strategy === "semantic" && embedding) {
        const result = await this.collection.query({
          queryEmbeddings: [embedding],
          nResults: limit,
          where: where as Record<string, unknown>,
          include: ["metadatas", "documents"],
        });

        const memories: Memory[] = [];
        for (let i = 0; i < (result.ids[0]?.length ?? 0); i++) {
          const mem = this._toMemory(
            result.ids[0][i],
            result.metadatas[0]?.[i] ?? null,
            result.documents[0]?.[i] ?? null,
            null
          );
          if (!mem.expiresAt || mem.expiresAt > new Date()) {
            memories.push(mem);
          }
        }
        return memories;
      }

      const result = await this.collection.get({
        where: where as Record<string, unknown>,
        limit: query.strategy ? limit * 3 : limit,
        include: ["metadatas", "documents", "embeddings"],
      });

      let memories: Memory[] = [];
      const now = new Date();
      for (let i = 0; i < result.ids.length; i++) {
        const mem = this._toMemory(
          result.ids[i],
          result.metadatas[i],
          result.documents[i],
          result.embeddings[i]
        );
        if (mem.expiresAt && mem.expiresAt <= now) continue;
        if (query.memoryTypes && query.memoryTypes.length > 0 && !query.memoryTypes.includes(mem.memoryType)) continue;
        if (query.tags && query.tags.length > 0 && !mem.tags.some((t) => query.tags!.includes(t))) continue;
        if (query.query) {
          const q = query.query.toLowerCase();
          if (!mem.content.toLowerCase().includes(q)) continue;
        }
        memories.push(mem);
      }

      switch (query.strategy) {
        case "recent":
          memories.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          break;
        case "important":
          memories.sort((a, b) => b.importance - a.importance);
          break;
        case "hybrid":
        default:
          memories.sort((a, b) => b.importance - a.importance || b.createdAt.getTime() - a.createdAt.getTime());
          break;
      }

      return memories.slice(0, limit);
    } catch (err) {
      throw storageError(`Failed to retrieve memories: ${(err as Error).message}`, err);
    }
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    try {
      if (!filter?.actorId && !filter?.memoryType && filter?.minImportance === undefined) {
        return await this.collection.count();
      }

      const where: Record<string, unknown> = {};
      if (filter.actorId) {
        where.actorId = { $eq: filter.actorId };
      }
      if (filter.memoryType) {
        where.memoryType = { $eq: filter.memoryType };
      }

      const result = await this.collection.get({
        where,
        limit: 100000,
        include: ["metadatas"],
      });

      let count = result.ids.length;
      if (filter.minImportance !== undefined) {
        count = result.metadatas.filter(
          (m) => m && (m.importance as number) >= filter.minImportance!
        ).length;
      }

      return count;
    } catch (err) {
      throw storageError(`Failed to count memories: ${(err as Error).message}`, err);
    }
  }

  async close(): Promise<void> {}

  private _serializeMetadata(memory: Memory): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      actorId: memory.actorId,
      memoryType: memory.memoryType,
      importance: memory.importance,
      emotionalValence: memory.emotionalValence,
      tags: memory.tags,
      createdAt: memory.createdAt.toISOString(),
    };
    if (memory.sourceId) meta.sourceId = memory.sourceId;
    if (memory.metadata && Object.keys(memory.metadata).length > 0) {
      meta.userMetadata = JSON.stringify(memory.metadata);
    }
    if (memory.expiresAt) {
      meta.expiresAt = memory.expiresAt.toISOString();
    }
    return meta;
  }

  private _toMemory(
    id: string,
    metadata: Record<string, unknown> | null,
    document: string | null,
    embedding: number[] | null
  ): Memory {
    const meta = metadata ?? {};
    return {
      id,
      actorId: (meta.actorId as string) ?? "",
      memoryType: (meta.memoryType as MemoryType) ?? "interaction",
      content: document ?? "",
      importance: (meta.importance as number) ?? 0.5,
      emotionalValence: (meta.emotionalValence as number) ?? 0,
      tags: (meta.tags as string[]) ?? [],
      embedding: embedding ?? undefined,
      sourceId: meta.sourceId as string | undefined,
      metadata: meta.userMetadata ? JSON.parse(meta.userMetadata as string) : {},
      expiresAt: meta.expiresAt ? new Date(meta.expiresAt as string) : undefined,
      createdAt: meta.createdAt ? new Date(meta.createdAt as string) : new Date(),
    };
  }
}
