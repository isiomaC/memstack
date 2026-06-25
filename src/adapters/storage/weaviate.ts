import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { notFound } from "../../errors.js";

type WeaviateClient = {
  collections: {
    create(opts: { name: string; properties: { name: string; dataType: string }[]; vectorizers?: unknown }): Promise<unknown>;
    get(name: string): WeaviateCollection;
    delete(name: string): Promise<void>;
    exists(name: string): Promise<boolean>;
    listAll(): Promise<string[]>;
  };
};

type WeaviateCollection = {
  data: {
    insert(opts: { properties: Record<string, unknown>; vectors: number[]; id?: string }): Promise<string>;
    deleteById(id: string): Promise<void>;
  };
  query: {
    fetchObjectById(id: string, opts?: { includeVector?: boolean }): Promise<{ properties: Record<string, unknown>; vectors?: { default?: number[] } } | null>;
    fetchObjects(opts: { limit: number; filters?: unknown; includeVector?: boolean }): Promise<{ objects: { uuid: string; properties: Record<string, unknown>; vectors?: { default?: number[] }; metadata?: { creationTimeUnix: number } }[] }>;
    nearVector(vector: number[], opts: { limit: number; returnProperties?: string[]; returnMetadata?: string[]; filters?: unknown; includeVector?: boolean }): Promise<{ objects: { uuid: string; properties: Record<string, unknown>; vectors?: { default?: number[] }; metadata?: { creationTimeUnix: number } }[] }>;
  };
  config: {
    get(): Promise<{ name: string }>;
    update(opts: { vectorIndexConfig: Record<string, unknown> }): Promise<void>;
  };
};

export interface WeaviateStorageConfig {
  client: WeaviateClient;
  className?: string;
}

export class WeaviateStorageAdapter implements StorageProvider {
  private client: WeaviateClient;
  private className: string;
  private _collection: WeaviateCollection | null = null;
  private _idToWv = new Map<string, string>();

  constructor(config: WeaviateStorageConfig) {
    this.client = config.client;
    this.className = config.className ?? "MemstackMemory";
  }

  async initialize(): Promise<void> {
    this._collection = this.client.collections.get(this.className);
  }

  private collection(): WeaviateCollection {
    if (!this._collection) {
      this._collection = this.client.collections.get(this.className);
    }
    return this._collection;
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

    const wvId = await this.collection().data.insert({
      id: crypto.randomUUID(),
      properties: this._toProperties(memory),
      vectors: input.embedding ?? new Array(1536).fill(0),
    });
    this._idToWv.set(memory.id, wvId);

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
    const wvId = this._idToWv.get(id);
    if (!wvId) return null;

    const obj = await this.collection().query.fetchObjectById(wvId, { includeVector: true });
    if (!obj) return null;

    const memory = this._fromProperties(obj.properties, obj.vectors?.default ?? undefined);
    if (memory.expiresAt && memory.expiresAt <= new Date()) return null;
    return memory;
  }

  async delete(id: string): Promise<void> {
    const wvId = this._idToWv.get(id);
    if (!wvId) throw notFound("Memory", id);
    await this.collection().data.deleteById(wvId);
    this._idToWv.delete(id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      try {
        await this.delete(id);
        count++;
      } catch {
        //
      }
    }
    return count;
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const strategy = query.strategy ?? "recent";
    const limit = query.limit ?? 10;

    if ((strategy === "semantic" || strategy === "hybrid") && embedding) {
      const filters = this._buildFilter(query);
      const result = await this.collection().query.nearVector(embedding, {
        limit: 100,
        filters,
        includeVector: true,
      });

      let objects = result.objects.map((o) => ({
        ...this._fromProperties(o.properties, o.vectors?.default),
        _score: o.metadata?.creationTimeUnix ?? 0,
      }));

      objects = objects.filter((o) => !o.expiresAt || o.expiresAt > new Date());

      if (query.actorId) {
        objects = objects.filter((o) => o.actorId === query.actorId);
      }

      if (strategy === "hybrid") {
        objects.sort((a, b) => (b._score + b.importance) - (a._score + a.importance));
      }

      return objects.slice(0, limit);
    }

    const filters = this._buildFilter(query);
    const result = await this.collection().query.fetchObjects({
      limit: 10000,
      filters,
    });

    let objects = result.objects.map((o) => ({
      ...this._fromProperties(o.properties, o.vectors?.default),
      _createdAt: o.properties.createdAt as string,
      _importance: (o.properties.importance as number) ?? 0.5,
    }));

    objects = objects.filter((o) => !o.expiresAt || o.expiresAt > new Date());

    if (query.actorId) {
      objects = objects.filter((o) => o.actorId === query.actorId);
    }

    switch (strategy) {
      case "recent":
        objects.sort((a, b) => new Date(b._createdAt).getTime() - new Date(a._createdAt).getTime());
        break;
      case "important":
        objects.sort((a, b) => b._importance - a._importance);
        break;
      case "hybrid":
      case "semantic":
      default:
        objects.sort((a, b) => b._importance - a._importance || new Date(b._createdAt).getTime() - new Date(a._createdAt).getTime());
        break;
    }

    return objects.slice(0, limit);
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const and: unknown[] = [];
    if (filter?.actorId) {
      and.push({ operator: "Equal", target: { property: "actorId" }, value: filter.actorId });
    }
    if (filter?.memoryType) {
      and.push({ operator: "Equal", target: { property: "memoryType" }, value: filter.memoryType });
    }
    if (filter?.minImportance !== undefined) {
      and.push({ operator: "GreaterThanEqual", target: { property: "importance" }, value: filter.minImportance });
    }

    const finalFilter = and.length === 0 ? undefined : and.length === 1 ? and[0] : { operator: "And", filters: and };
    const result = await this.collection().query.fetchObjects({
      limit: 10000,
      filters: finalFilter,
    });
    return result.objects.length;
  }

  async close(): Promise<void> {
    //
  }

  private _buildFilter(query: MemoryRetrieveQuery): unknown {
    const and: unknown[] = [];

    if (query.actorId) {
      and.push({ operator: "Equal", target: { property: "actorId" }, value: query.actorId });
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      if (query.memoryTypes.length === 1) {
        and.push({ operator: "Equal", target: { property: "memoryType" }, value: query.memoryTypes[0] });
      } else {
        and.push({
          operator: "Or",
          filters: query.memoryTypes.map((t) => ({ operator: "Equal", target: { property: "memoryType" }, value: t })),
        });
      }
    }
    if (query.tags && query.tags.length > 0) {
      if (query.tags.length === 1) {
        and.push({ operator: "ContainsAny", target: { property: "tags" }, values: query.tags });
      } else {
        and.push({
          operator: "Or",
          filters: query.tags.map((t) => ({ operator: "ContainsAny", target: { property: "tags" }, values: [t] })),
        });
      }
    }
    if (query.query) {
      and.push({ operator: "Like", target: { property: "content" }, value: `*${query.query}*` });
    }

    return and.length === 0 ? undefined : and.length === 1 ? and[0] : { operator: "And", filters: and };
  }

  private _toProperties(memory: Memory): Record<string, unknown> {
    return {
      _memstackId: memory.id,
      actorId: memory.actorId,
      memoryType: memory.memoryType,
      content: memory.content,
      importance: memory.importance,
      emotionalValence: memory.emotionalValence,
      tags: memory.tags,
      metadata: JSON.stringify(memory.metadata ?? {}),
      sourceId: memory.sourceId ?? null,
      expiresAt: memory.expiresAt?.toISOString() ?? null,
      createdAt: memory.createdAt.toISOString(),
    };
  }

  private _fromProperties(props: Record<string, unknown>, vectors?: number[]): Memory {
    return {
      id: (props._memstackId as string) ?? "",
      actorId: (props.actorId as string) ?? "",
      memoryType: (props.memoryType as MemoryType) ?? "interaction",
      content: (props.content as string) ?? "",
      importance: (props.importance as number) ?? 0.5,
      emotionalValence: (props.emotionalValence as number) ?? 0,
      tags: Array.isArray(props.tags) ? (props.tags as string[]) : [],
      embedding: vectors,
      sourceId: (props.sourceId as string) ?? undefined,
      metadata: typeof props.metadata === "string" ? JSON.parse(props.metadata as string) : (props.metadata ?? {}),
      expiresAt: props.expiresAt ? new Date(props.expiresAt as string) : undefined,
      createdAt: new Date((props.createdAt as string) ?? new Date().toISOString()),
    };
  }
}
