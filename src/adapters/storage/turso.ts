import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { notFound, configError } from "../../errors.js";

type LibSQLClient = {
  execute(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowsAffected: number }>;
  batch(queries: string[]): Promise<unknown[]>;
  close(): Promise<void>;
};

interface TursoMemoryRow {
  id: string;
  actor_id: string;
  memory_type: string;
  content: string;
  importance: number;
  emotional_valence: number;
  tags: string;
  embedding: number[] | ArrayBuffer | Uint8Array | null;
  source_id: string | null;
  metadata: string;
  expires_at: string | null;
  created_at: string;
  touched_at: string;
}

export interface TursoStorageConfig {
  client: LibSQLClient;
  tableName?: string;
  vectorDimensions?: number;
}

export class TursoStorageAdapter implements StorageProvider {
  private client: LibSQLClient;
  private table: string;
  private vectorDimensions: number;

  constructor(config: TursoStorageConfig) {
    this.client = config.client;
    this.table = config.tableName ?? "memstack_memories";
    if (!/^[a-zA-Z0-9_]+$/.test(this.table)) {
      throw configError(`Invalid table name: "${this.table}". Use only alphanumeric characters and underscores.`);
    }
    this.vectorDimensions = config.vectorDimensions ?? 1536;
  }

  async initialize(): Promise<void> {
    await this._runMigration();
  }

  private async _runMigration(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'interaction',
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        emotional_valence REAL NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        embedding F32_BLOB,
        source_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT,
        created_at TEXT NOT NULL,
        touched_at TEXT NOT NULL
      )
    `);
    try {
      await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_${this.table}_actor ON ${this.table}(actor_id)`);
      await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_${this.table}_created ON ${this.table}(created_at DESC)`);
      await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_${this.table}_importance ON ${this.table}(importance DESC)`);
    } catch { /* index creation may fail; non-critical */ }
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const now = new Date().toISOString();
    const id = input.id ?? this.generateId();

    await this.client.execute(
      `INSERT INTO ${this.table} (id, actor_id, memory_type, content, importance, emotional_valence, tags, embedding, source_id, metadata, expires_at, created_at, touched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         importance = excluded.importance,
         emotional_valence = excluded.emotional_valence,
         tags = excluded.tags,
         embedding = excluded.embedding,
         source_id = excluded.source_id,
         metadata = excluded.metadata,
         expires_at = excluded.expires_at,
         touched_at = excluded.touched_at`,
      [
        id,
        input.actorId,
        input.memoryType ?? "interaction",
        input.content,
        input.importance ?? 0.5,
        input.emotionalValence ?? 0,
        JSON.stringify(input.tags ?? []),
        input.embedding ? this._encodeEmbedding(input.embedding) : null,
        input.sourceId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.expiresAt?.toISOString() ?? null,
        now,
        now,
      ]
    );

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
      createdAt: input.createdAt ?? new Date(now),
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
    const { rows } = await this.client.execute(
      `SELECT * FROM ${this.table} WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [id, new Date().toISOString()]
    );
    if (rows.length === 0) return null;
    return this._rowToMemory(rows[0] as TursoMemoryRow);
  }

  async delete(id: string): Promise<void> {
    const { rows } = await this.client.execute(`SELECT id FROM ${this.table} WHERE id = ?`, [id]);
    if (rows.length === 0) throw notFound("Memory", id);
    await this.client.execute(`DELETE FROM ${this.table} WHERE id = ?`, [id]);
  }

  async deleteMany(ids: string[]): Promise<number> {
    const placeholders = ids.map(() => "?").join(", ");
    const { rows } = await this.client.execute(
      `DELETE FROM ${this.table} WHERE id IN (${placeholders}) RETURNING id`,
      ids
    );
    return rows.length;
  }

  async touch(id: string): Promise<void> {
    const { rows } = await this.client.execute(`SELECT id FROM ${this.table} WHERE id = ?`, [id]);
    if (rows.length === 0) throw notFound("Memory", id);
    await this.client.execute(
      `UPDATE ${this.table} SET touched_at = ? WHERE id = ?`,
      [new Date().toISOString(), id]
    );
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const conditions: string[] = ["(expires_at IS NULL OR expires_at > ?)"];
    const params: unknown[] = [new Date().toISOString()];

    if (query.actorId) {
      conditions.push("actor_id = ?");
      params.push(query.actorId);
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      conditions.push(`memory_type IN (${query.memoryTypes.map(() => "?").join(", ")})`);
      params.push(...query.memoryTypes);
    }
    if (query.tags && query.tags.length > 0) {
      const tagConditions = query.tags.map(() => "tags LIKE ?").join(" OR ");
      conditions.push(`(${tagConditions})`);
      params.push(...query.tags.map((t) => `%${t}%`));
    }
    if (query.query) {
      conditions.push("content LIKE ?");
      params.push(`%${query.query}%`);
    }
    if (query.createdAfter) {
      conditions.push("created_at >= ?");
      params.push(query.createdAfter.toISOString());
    }
    if (query.createdBefore) {
      conditions.push("created_at <= ?");
      params.push(query.createdBefore.toISOString());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let orderBy: string;
    switch (query.strategy) {
      case "recent":
        orderBy = "touched_at DESC";
        break;
      case "important":
        orderBy = "importance DESC";
        break;
      case "hybrid":
      case "semantic":
      default:
        if (embedding) {
          return this._semanticRetrieve(embedding, query, params, where);
        }
        orderBy = "touched_at DESC";
        break;
    }

    const limit = query.limit ?? 10;
    const sql = `SELECT * FROM ${this.table} ${where} ORDER BY ${orderBy} LIMIT ?`;
    params.push(limit);

    const { rows } = await this.client.execute(sql, params);

    for (const row of rows.slice(0, limit)) {
      const r = row as TursoMemoryRow;
      await this.client.execute(
        `UPDATE ${this.table} SET touched_at = ? WHERE id = ?`,
        [new Date().toISOString(), r.id]
      );
    }

    return (rows as TursoMemoryRow[]).map((r) => this._rowToMemory(r));
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const conditions: string[] = ["(expires_at IS NULL OR expires_at > ?)"];
    const params: unknown[] = [new Date().toISOString()];

    if (filter?.actorId) {
      conditions.push("actor_id = ?");
      params.push(filter.actorId);
    }
    if (filter?.memoryType) {
      conditions.push("memory_type = ?");
      params.push(filter.memoryType);
    }
    if (filter?.minImportance !== undefined) {
      conditions.push("importance >= ?");
      params.push(filter.minImportance);
    }
    if (filter?.createdAfter) {
      conditions.push("created_at >= ?");
      params.push(filter.createdAfter.toISOString());
    }
    if (filter?.createdBefore) {
      conditions.push("created_at <= ?");
      params.push(filter.createdBefore.toISOString());
    }

    const where = conditions.join(" AND ");
    const { rows } = await this.client.execute(
      `SELECT COUNT(*) as count FROM ${this.table} WHERE ${where}`,
      params
    );
    return Number((rows[0] as { count: number }).count);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async _semanticRetrieve(
    embedding: number[],
    query: MemoryRetrieveQuery,
    params: unknown[],
    baseWhere: string
  ): Promise<Memory[]> {
    const limit = query.limit ?? 10;
    const conditions = baseWhere.replace(/^WHERE\s+/i, "");
    const whereClause = conditions
      ? `WHERE ${conditions} AND embedding IS NOT NULL`
      : `WHERE embedding IS NOT NULL`;
    const isHybrid = query.strategy === "hybrid";
    const encodedEmbedding = this._encodeEmbedding(embedding);
    const sql = isHybrid ? `
      SELECT *, vector_distance_cos(embedding, vector32(?)) AS distance,
        (1.0 - vector_distance_cos(embedding, vector32(?)) / 2.0 + importance) AS score
      FROM ${this.table}
      ${whereClause}
      ORDER BY score DESC
      LIMIT ?
    ` : `
      SELECT *, vector_distance_cos(embedding, vector32(?)) AS distance
      FROM ${this.table}
      ${whereClause}
      ORDER BY distance ASC
      LIMIT ?
    `;

    // Build parameter array sequentially to match SQL placeholder ordering:
    // 1. Encoded embedding(s) for vector32() / vector_distance_cos() calls
    const allParams: unknown[] = [encodedEmbedding];
    if (isHybrid) {
      allParams.push(encodedEmbedding);
    }
    // 2. WHERE clause params (expires check + filter conditions from retrieve())
    allParams.push(...params);
    // 3. LIMIT
    allParams.push(limit);

    const { rows } = await this.client.execute(sql, allParams);

    for (const row of rows.slice(0, limit)) {
      const r = row as TursoMemoryRow;
      await this.client.execute(
        `UPDATE ${this.table} SET touched_at = ? WHERE id = ?`,
        [new Date().toISOString(), r.id]
      );
    }

    return (rows as TursoMemoryRow[]).map((r) => this._rowToMemory(r));
  }

  private _rowToMemory(row: TursoMemoryRow): Memory {
    return {
      id: row.id,
      actorId: row.actor_id,
      memoryType: row.memory_type as MemoryType,
      content: row.content,
      importance: row.importance,
      emotionalValence: row.emotional_valence,
      tags: this._parseJson(row.tags, []) as string[],
      embedding: row.embedding ? this._decodeEmbedding(row.embedding) : undefined,
      sourceId: row.source_id ?? undefined,
      metadata: this._parseJson(row.metadata, {}) as Record<string, unknown>,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
    };
  }

  private _encodeEmbedding(embedding: number[]): Uint8Array {
    return new Uint8Array(new Float32Array(embedding).buffer);
  }

  private _decodeEmbedding(blob: number[] | ArrayBuffer | Uint8Array): number[] {
    if (blob instanceof ArrayBuffer) {
      return Array.from(new Float32Array(blob));
    }
    if (blob instanceof Uint8Array) {
      return Array.from(new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)));
    }
    return blob;
  }

  private _parseJson(value: string, fallback: unknown): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
}
