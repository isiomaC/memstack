import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError, notFound, configError } from "../../errors.js";

type LanceDBConnection = {
  createTable(name: string, data: { id: string; vector: number[]; actor_id: string; memory_type: string; content: string; importance: number; emotional_valence: number; tags: string; source_id: string; metadata: string; expires_at: string; created_at: string }[]): Promise<LanceDBTable>;
  openTable(name: string): Promise<LanceDBTable>;
  tableNames(): Promise<string[]>;
};

type LanceDBTable = {
  add(data: { id: string; vector: number[]; actor_id: string; memory_type: string; content: string; importance: number; emotional_valence: number; tags: string; source_id: string; metadata: string; expires_at: string; created_at: string }[]): Promise<void>;
  search(vector: number[]): { limit(n: number): { where(predicate: string): { execute(): Promise<{ id: string; _distance: number; vector: number[]; actor_id: string; memory_type: string; content: string; importance: number; emotional_valence: number; tags: string; source_id: string; metadata: string; expires_at: string; created_at: string }[]> } } };
  delete(predicate: string): Promise<void>;
  countRows(predicate?: string): Promise<number>;
};

export interface LanceDBStorageConfig {
  connection: LanceDBConnection;
  tableName?: string;
}

interface LanceDBMemoryRow {
  id: string;
  vector: number[];
  actor_id: string;
  memory_type: string;
  content: string;
  importance: number;
  emotional_valence: number;
  tags: string;
  source_id: string;
  metadata: string;
  expires_at: string;
  created_at: string;
  _distance?: number;
}

export class LanceDBStorageAdapter implements StorageProvider {
  private connection: LanceDBConnection;
  private table!: LanceDBTable;
  private tableName: string;
  private _zeroVector: number[];

  constructor(config: LanceDBStorageConfig) {
    if (!config.connection) {
      throw configError("LanceDBStorageAdapter requires a LanceDB connection instance");
    }
    this.connection = config.connection;
    this.tableName = config.tableName ?? "memstack";
    this._zeroVector = new Array(1536).fill(0);
  }

  async initialize(): Promise<void> {
    const tables = await this.connection.tableNames();
    if (!tables.includes(this.tableName)) {
      this.table = await this.connection.createTable(this.tableName, []);
    } else {
      this.table = await this.connection.openTable(this.tableName);
    }
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const now = new Date();
    const id = input.id ?? this.generateId();

    const row = {
      id,
      vector: input.embedding ?? this._zeroVector,
      actor_id: input.actorId,
      memory_type: input.memoryType ?? "interaction",
      content: input.content,
      importance: input.importance ?? 0.5,
      emotional_valence: input.emotionalValence ?? 0,
      tags: JSON.stringify(input.tags ?? []),
      source_id: input.sourceId ?? "",
      metadata: JSON.stringify(input.metadata ?? {}),
      expires_at: input.expiresAt?.toISOString() ?? "",
      created_at: now.toISOString(),
    };

    await this.table.add([row]);

    return {
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
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const input of inputs) {
      results.push(await this.store(input));
    }
    return results;
  }

  async get(id: string): Promise<Memory | null> {
    const results = await this.table.search(this._zeroVector).limit(1).where(`id = "${id}"`).execute();
    if (results.length === 0) return null;

    const row = results[0];
    if (row.expires_at) {
      const expiresAt = new Date(row.expires_at);
      if (expiresAt <= new Date()) {
        await this.table.delete(`id = "${id}"`);
        return null;
      }
    }

    return this._rowToMemory(row);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw notFound("Memory", id);
    await this.table.delete(`id = "${id}"`);
  }

  async deleteMany(ids: string[]): Promise<number> {
    const before = await this.table.countRows();
    const inClause = ids.map((id) => `"${id}"`).join(", ");
    await this.table.delete(`id IN (${inClause})`);
    const after = await this.table.countRows();
    return before - after;
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const conditions: string[] = [];
    if (query.actorId) {
      conditions.push(`actor_id = "${query.actorId}"`);
    }

    const where = conditions.length > 0 ? conditions.join(" AND ") : "";

    const isSemantic = (query.strategy === "semantic" || query.strategy === "hybrid") && embedding && embedding.length > 0;
    const searchVec = isSemantic ? embedding! : this._zeroVector;
    const scanLimit = isSemantic ? (query.limit ?? 10) : 10000;

    const results = await this.table
      .search(searchVec)
      .limit(scanLimit)
      .where(where)
      .execute();

    let rows = results as LanceDBMemoryRow[];

    const now = new Date();
    rows = rows.filter((r) => !r.expires_at || new Date(r.expires_at) > now);

    if (query.actorId) {
      rows = rows.filter((r) => r.actor_id === query.actorId);
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      rows = rows.filter((r) => query.memoryTypes!.includes(r.memory_type as MemoryType));
    }
    if (query.tags && query.tags.length > 0) {
      rows = rows.filter((r) => {
        const tags: string[] = JSON.parse(r.tags);
        return tags.some((t) => query.tags!.includes(t));
      });
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      rows = rows.filter((r) => r.content.toLowerCase().includes(q));
    }

    const limit = query.limit ?? 10;

    if (isSemantic && query.strategy === "hybrid") {
      rows.sort((a, b) => {
        const scoreA = (a._distance ?? 0) + a.importance;
        const scoreB = (b._distance ?? 0) + b.importance;
        return scoreB - scoreA;
      });
    } else if (query.strategy === "recent") {
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (query.strategy === "important") {
      rows.sort((a, b) => b.importance - a.importance);
    } else if (!isSemantic) {
      rows.sort((a, b) => b.importance - a.importance || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    return rows.slice(0, limit).map((r) => this._rowToMemory(r));
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const conditions: string[] = [];
    if (filter?.actorId) {
      conditions.push(`actor_id = "${filter.actorId}"`);
    }

    const where = conditions.length > 0 ? conditions.join(" AND ") : "";

    const results = await this.table
      .search(this._zeroVector)
      .limit(10000)
      .where(where)
      .execute();

    const now = new Date();
    let rows = results.filter((r) => !r.expires_at || new Date(r.expires_at) > now);

    if (filter?.actorId) {
      rows = rows.filter((r) => r.actor_id === filter.actorId);
    }
    if (filter?.memoryType) {
      rows = rows.filter((r) => r.memory_type === filter.memoryType);
    }
    if (filter?.minImportance !== undefined) {
      rows = rows.filter((r) => r.importance >= filter.minImportance!);
    }

    return rows.length;
  }

  async close(): Promise<void> {
  }

  private _rowToMemory(row: LanceDBMemoryRow): Memory {
    return {
      id: row.id,
      actorId: row.actor_id,
      memoryType: row.memory_type as MemoryType,
      content: row.content,
      importance: row.importance,
      emotionalValence: row.emotional_valence,
      tags: row.tags ? JSON.parse(row.tags) : [],
      embedding: row.vector && row.vector.length > 0 ? row.vector : undefined,
      sourceId: row.source_id || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
    };
  }
}
