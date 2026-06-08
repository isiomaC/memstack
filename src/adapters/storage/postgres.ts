import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError, notFound } from "../../errors.js";

// User provides their own pg Pool instance
type PgPool = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

interface MemoryRecord extends Memory {
  _touchedAt: string;
}

interface PgMemoryRow {
  id: string;
  actor_id: string;
  memory_type: string;
  content: string;
  importance: number;
  emotional_valence: number;
  tags: string[];
  embedding: number[] | null;
  source_id: string | null;
  metadata: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
  touched_at: string;
}

export interface PostgresStorageConfig {
  /** An active pg Pool instance */
  pool: PgPool;
  /** Table name. Default: "memstack_memories" */
  tableName?: string;
  /** Automatically run CREATE TABLE IF NOT EXISTS on init. Default: true */
  autoMigrate?: boolean;
}

export class PostgresStorage implements StorageProvider {
  private pool: PgPool;
  private table: string;
  private autoMigrate: boolean;

  constructor(config: PostgresStorageConfig) {
    this.pool = config.pool;
    this.table = config.tableName ?? "memstack_memories";
    if (!/^[a-zA-Z0-9_]+$/.test(this.table)) {
      throw new Error(`Invalid table name: "${this.table}". Use only alphanumeric characters and underscores.`);
    }
    this.autoMigrate = config.autoMigrate ?? true;
  }

  async initialize(): Promise<void> {
    if (!this.autoMigrate) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'interaction',
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        emotional_valence REAL NOT NULL DEFAULT 0,
        tags JSONB NOT NULL DEFAULT '[]',
        embedding vector(3072),
        source_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Indexes
    try {
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_${this.table}_actor ON ${this.table} (actor_id)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_${this.table}_type ON ${this.table} (memory_type)`);
    } catch {
      // Index creation may fail; non-critical
    }
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const now = new Date().toISOString();
    const id = input.id ?? this.generateId();

    await this.pool.query(
      `INSERT INTO ${this.table} (id, actor_id, memory_type, content, importance, emotional_valence, tags, embedding, source_id, metadata, expires_at, created_at, touched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::float8[]::vector, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content,
         importance = EXCLUDED.importance,
         emotional_valence = EXCLUDED.emotional_valence,
         tags = EXCLUDED.tags,
         embedding = EXCLUDED.embedding,
         source_id = EXCLUDED.source_id,
         metadata = EXCLUDED.metadata,
         expires_at = EXCLUDED.expires_at,
         touched_at = EXCLUDED.touched_at`,
      [
        id,
        input.actorId,
        input.memoryType ?? "interaction",
        input.content,
        input.importance ?? 0.5,
        input.emotionalValence ?? 0,
        JSON.stringify(input.tags ?? []),
        input.embedding ? `{${input.embedding.join(",")}}` : null,
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
      createdAt: new Date(now),
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
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [id]
    );
    if (rows.length === 0) return null;
    return this._rowToMemory(rows[0] as PgMemoryRow);
  }

  async delete(id: string): Promise<void> {
    const { rows } = await this.pool.query(`SELECT id FROM ${this.table} WHERE id = $1`, [id]);
    if (rows.length === 0) throw notFound("Memory", id);
    await this.pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  async deleteMany(ids: string[]): Promise<number> {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.pool.query(
      `DELETE FROM ${this.table} WHERE id IN (${placeholders}) RETURNING id`,
      ids
    );
    return rows.length;
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const conditions: string[] = ["(expires_at IS NULL OR expires_at > NOW())"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (query.actorId) {
      conditions.push(`actor_id = $${paramIdx++}`);
      params.push(query.actorId);
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      conditions.push(`memory_type = ANY($${paramIdx++})`);
      params.push(query.memoryTypes);
    }
    if (query.tags && query.tags.length > 0) {
      conditions.push(`tags ?| $${paramIdx++}`);
      params.push(query.tags);
    }
    if (query.query) {
      conditions.push(`content ILIKE $${paramIdx++}`);
      params.push(`%${query.query}%`);
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
        if (embedding && query.query) {
          // Semantic: order by vector distance
          return this._semanticRetrieve(embedding, query, params, where);
        }
        orderBy = "importance DESC, touched_at DESC";
        break;
    }

    const limit = query.limit ?? 10;
    const sql = `SELECT * FROM ${this.table} ${where} ORDER BY ${orderBy} LIMIT $${paramIdx}`;
    params.push(limit);

    const { rows } = await this.pool.query(sql, params);

    // Touch records
    for (const row of rows.slice(0, limit)) {
      const r = row as PgMemoryRow;
      await this.pool.query(
        `UPDATE ${this.table} SET touched_at = NOW() WHERE id = $1`,
        [r.id]
      );
    }

    return (rows as PgMemoryRow[]).map((r) => this._rowToMemory(r));
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const conditions: string[] = ["(expires_at IS NULL OR expires_at > NOW())"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter?.actorId) {
      conditions.push(`actor_id = $${paramIdx++}`);
      params.push(filter.actorId);
    }
    if (filter?.memoryType) {
      conditions.push(`memory_type = $${paramIdx++}`);
      params.push(filter.memoryType);
    }
    if (filter?.minImportance !== undefined) {
      conditions.push(`importance >= $${paramIdx++}`);
      params.push(filter.minImportance);
    }

    const where = conditions.join(" AND ");
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) as count FROM ${this.table} WHERE ${where}`,
      params
    );
    return Number((rows[0] as { count: string }).count);
  }

  async close(): Promise<void> {
    // User manages pool lifecycle
  }

  // ── Internal ──

  private async _semanticRetrieve(
    embedding: number[],
    query: MemoryRetrieveQuery,
    params: unknown[],
    baseWhere: string
  ): Promise<Memory[]> {
    const vecParam = `{${embedding.join(",")}}`;
    const limit = query.limit ?? 10;
    // baseWhere already includes "WHERE" keyword; strip the prefix
    const conditions = baseWhere.replace(/^WHERE\s+/i, "");
    const whereClause = conditions
      ? `WHERE ${conditions} AND embedding IS NOT NULL`
      : `WHERE embedding IS NOT NULL`;
    const sql = `
      SELECT *,
        (embedding <-> $${params.length + 1}::float8[]::vector) AS distance
      FROM ${this.table}
      ${whereClause}
      ORDER BY distance ASC
      LIMIT $${params.length + 2}
    `;
    params.push(vecParam);
    params.push(limit);

    const { rows } = await this.pool.query(sql, params);

    for (const row of rows.slice(0, limit)) {
      const r = row as PgMemoryRow;
      await this.pool.query(`UPDATE ${this.table} SET touched_at = NOW() WHERE id = $1`, [r.id]);
    }

    return (rows as PgMemoryRow[]).map((r) => this._rowToMemory(r));
  }

  private _rowToMemory(row: PgMemoryRow): Memory {
    return {
      id: row.id,
      actorId: row.actor_id,
      memoryType: row.memory_type as MemoryType,
      content: row.content,
      importance: row.importance,
      emotionalValence: row.emotional_valence,
      tags: Array.isArray(row.tags) ? row.tags : [],
      embedding: row.embedding ?? undefined,
      sourceId: row.source_id ?? undefined,
      metadata: row.metadata ?? {},
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
    };
  }
}
