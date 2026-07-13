import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError, notFound, configError } from "../../errors.js";

type ZepClient = {
  memory: {
    add(sessionId: string, messages: unknown[]): Promise<unknown>;
    get(sessionId: string, params?: { lastn?: number }): Promise<{ messages?: unknown[] }>;
    search(sessionId: string, query: { text: string; metadata?: Record<string, unknown> }, limit?: number): Promise<unknown[]>;
    delete(sessionId: string): Promise<void>;
  };
};

interface ZepMessage {
  uuid: string;
  role: string;
  content: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface ZepAddResponse {
  uuid?: string;
}

export interface ZepStorageConfig {
  mode: "cloud" | "community";
  apiKey?: string;
  baseUrl?: string;
}

export class ZepStorageAdapter implements StorageProvider {
  private config: ZepStorageConfig;
  private client!: ZepClient;
  private _actorMap = new Map<string, string>();
  private _deletedIds = new Set<string>();

  constructor(config: ZepStorageConfig) {
    if (config.mode === "community" && !config.baseUrl) {
      throw configError("baseUrl is required for Zep community mode");
    }
    if (config.mode === "cloud" && !config.apiKey) {
      throw configError("apiKey is required for Zep cloud mode");
    }
    this.config = config;
  }

  async initialize(): Promise<void> {
    // @ts-expect-error - @getzep/zep-cloud is an optional peer dependency
    const mod = await import("@getzep/zep-cloud");
    const ZepClientCtor = mod.ZepClient as new (opts: Record<string, unknown>) => ZepClient;
    if (this.config.mode === "cloud") {
      this.client = new ZepClientCtor({ apiKey: this.config.apiKey });
    } else {
      this.client = new ZepClientCtor({
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
      });
    }
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const sessionId = input.actorId;
    const memoryType = (input.memoryType ?? "interaction") as MemoryType;
    const now = new Date();

    const message = {
      role: "user",
      role_type: "user",
      content: input.content,
      metadata: {
        memoryType,
        importance: input.importance ?? 0.5,
        emotionalValence: input.emotionalValence ?? 0,
        tags: input.tags ?? [],
        sourceId: input.sourceId,
        actorId: input.actorId,
        expiresAt: input.expiresAt?.toISOString(),
        extra: input.metadata ?? {},
      },
    };

    try {
      const result = (await this.client.memory.add(sessionId, [message])) as ZepAddResponse;
      const id = input.id ?? result.uuid ?? this.generateId();

      const memory: Memory = {
        id,
        actorId: input.actorId,
        memoryType,
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

      this._actorMap.set(id, input.actorId);
      return memory;
    } catch (err) {
      throw storageError("Failed to store memory in Zep", err);
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
    if (this._deletedIds.has(id)) return null;

    const actorId = this._actorMap.get(id);
    if (!actorId) return null;

    try {
      const result = await this.client.memory.get(actorId, { lastn: 1000 });
      if (!result.messages) return null;

      const msg = result.messages.find(
        (m) => (m as ZepMessage).uuid === id
      ) as ZepMessage | undefined;

      if (!msg) return null;

      return this._zepMessageToMemory(msg, actorId);
    } catch (err) {
      throw storageError("Failed to get memory from Zep", err);
    }
  }

  async delete(id: string): Promise<void> {
    if (this._deletedIds.has(id)) throw notFound("Memory", id);
    if (!this._actorMap.has(id)) throw notFound("Memory", id);

    const actorId = this._actorMap.get(id)!;
    this._deletedIds.add(id);
    this._actorMap.delete(id);

    try {
      await this.client.memory.delete(actorId);
    } catch {
    }
  }

  async deleteMany(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if (!this._deletedIds.has(id) && this._actorMap.has(id)) {
        const actorId = this._actorMap.get(id)!;
        this._deletedIds.add(id);
        this._actorMap.delete(id);

        try {
          await this.client.memory.delete(actorId);
        } catch {
        }
        count++;
      }
    }
    return count;
  }

  async retrieve(query: MemoryRetrieveQuery, _embedding?: number[]): Promise<Memory[]> {
    const sessionId = query.actorId;
    if (!sessionId) return [];

    try {
      const searchQuery: { text: string; metadata?: Record<string, unknown> } = {
        text: query.query ?? "",
      };

      if (query.memoryTypes && query.memoryTypes.length > 0) {
        searchQuery.metadata = { memoryType: query.memoryTypes[0] };
      }

      const limit = query.limit ?? 10;
      const zepResults = await this.client.memory.search(sessionId, searchQuery, limit);

      const memories: Memory[] = [];
      for (const raw of zepResults) {
        const msg = raw as ZepMessage;
        const memory = this._zepMessageToMemory(msg, sessionId);
        if (memory) memories.push(memory);
      }

      if (query.memoryTypes && query.memoryTypes.length > 1) {
        const types = new Set(query.memoryTypes);
        return memories.filter((m) => types.has(m.memoryType)).slice(0, limit);
      }

      switch (query.strategy) {
        case "important":
          return memories
            .filter((m) => m.importance >= 0.5)
            .sort((a, b) => b.importance - a.importance)
            .slice(0, limit);
        case "recent":
          return memories
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, limit);
        default:
          return memories.slice(0, limit);
      }
    } catch (err) {
      throw storageError("Failed to retrieve memories from Zep", err);
    }
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    if (!filter?.actorId) {
      let total = 0;
      for (const actorId of this._actorMap.values()) {
        total += await this._countForActor(actorId, filter);
      }
      return total;
    }
    return this._countForActor(filter.actorId, filter);
  }

  private async _countForActor(actorId: string, filter?: MemoryCountFilter): Promise<number> {
    try {
      const result = await this.client.memory.get(actorId, { lastn: 10000 });
      if (!result.messages) return 0;

      let messages = result.messages as ZepMessage[];

      messages = messages.filter((m) => {
        if (this._deletedIds.has(m.uuid)) return false;
        return true;
      });

      if (filter?.memoryType) {
        messages = messages.filter(
          (m) => m.metadata?.memoryType === filter.memoryType
        );
      }
      if (filter?.minImportance !== undefined) {
        messages = messages.filter(
          (m) => (m.metadata?.importance as number) >= filter.minImportance!
        );
      }

      return messages.length;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    this._actorMap.clear();
    this._deletedIds.clear();
  }

  private _zepMessageToMemory(msg: ZepMessage, actorId: string): Memory | null {
    if (this._deletedIds.has(msg.uuid)) return null;

    const meta = msg.metadata ?? {};

    const expiresAtStr = meta.expiresAt as string | undefined;
    const expiresAt = expiresAtStr ? new Date(expiresAtStr) : undefined;

    if (expiresAt && expiresAt <= new Date()) {
      this._deletedIds.add(msg.uuid);
      return null;
    }

    return {
      id: msg.uuid,
      actorId,
      memoryType: (meta.memoryType as MemoryType) ?? "interaction",
      content: msg.content,
      importance: (meta.importance as number) ?? 0.5,
      emotionalValence: (meta.emotionalValence as number) ?? 0,
      tags: (meta.tags as string[]) ?? [],
      embedding: meta.embedding as number[] | undefined,
      sourceId: meta.sourceId as string | undefined,
      metadata: (meta.extra as Record<string, unknown>) ?? {},
      expiresAt,
      createdAt: new Date(msg.created_at),
    };
  }
}
