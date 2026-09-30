import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter, StorageCapabilities } from "../../interfaces.js";
import { notFound, configError } from "../../errors.js";

type BetterSqlite3Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown | undefined;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
  inTransaction?: boolean;
};

interface SqliteMemoryRow {
  id: string;
  actor_id: string;
  memory_type: string;
  content: string;
  importance: number;
  emotional_valence: number;
  tags: string;
  embedding: string | null;
  source_id: string | null;
  metadata: string;
  expires_at: string | null;
  created_at: string;
  touched_at: string;
}

export interface SQLiteStorageConfig {
  db: BetterSqlite3Db;
  tableName?: string;
  vectorDimensions?: number;
  /** How long a write waits for another connection's lock before failing. Default 5000. */
  busyTimeoutMs?: number;
  /** Use write-ahead logging so readers never block and writers queue. Default true. */
  walMode?: boolean;
}

const MIGRATIONS_TABLE = "memstack_schema_migrations";

interface Migration {
  version: number;
  sql(table: string): string;
}

// Append-only: never edit a released migration, add a new version instead.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: (t) => `
      CREATE TABLE IF NOT EXISTS ${t} (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'interaction',
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        emotional_valence REAL NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        embedding TEXT,
        source_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT,
        created_at TEXT NOT NULL,
        touched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${t}_actor ON ${t}(actor_id);
      CREATE INDEX IF NOT EXISTS idx_${t}_created ON ${t}(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_${t}_importance ON ${t}(importance DESC);
    `,
  },
];

export const SQLITE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const dims = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < dims; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

export class SQLiteStorageAdapter implements StorageProvider {
  readonly capabilities: StorageCapabilities = { multiProcess: true };
  private db: BetterSqlite3Db;
  private table: string;
  private vectorDimensions: number;
  private busyTimeoutMs: number;
  private walMode: boolean;

  constructor(config: SQLiteStorageConfig) {
    if (!config.db) {
      throw configError("SQLiteStorageAdapter requires a better-sqlite3 database instance");
    }
    this.db = config.db;
    this.table = config.tableName ?? "memstack_memories";
    if (!/^[a-zA-Z0-9_]+$/.test(this.table)) {
      throw configError(`Invalid table name: "${this.table}". Use only alphanumeric characters and underscores.`);
    }
    this.vectorDimensions = config.vectorDimensions ?? 1536;
    this.busyTimeoutMs = config.busyTimeoutMs ?? 5000;
    if (!Number.isInteger(this.busyTimeoutMs) || this.busyTimeoutMs < 0) {
      throw configError(`Invalid busyTimeoutMs: ${config.busyTimeoutMs}. Use a non-negative integer.`);
    }
    this.walMode = config.walMode ?? true;
  }

  async initialize(): Promise<void> {
    // Set the timeout first so switching to WAL also waits for other connections.
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    if (this.walMode) this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  /** Schema version applied to this adapter's table, 0 if none. */
  schemaVersion(): number {
    const row = this.db.prepare(
      `SELECT version FROM ${MIGRATIONS_TABLE} WHERE table_name = ?`
    ).get(this.table) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  // Versions are tracked per table rather than with PRAGMA user_version,
  // so adapters with different table names can share one database file.
  private migrate(): void {
    for (const migration of MIGRATIONS) {
      this.transaction(() => {
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (table_name TEXT PRIMARY KEY, version INTEGER NOT NULL)`
        );
        // Re-read inside the write lock: another process may have just applied it.
        if (this.schemaVersion() >= migration.version) return;
        this.db.exec(migration.sql(this.table));
        this.db.prepare(
          `INSERT INTO ${MIGRATIONS_TABLE} (table_name, version) VALUES (?, ?)
           ON CONFLICT(table_name) DO UPDATE SET version = excluded.version`
        ).run(this.table, migration.version);
      });
    }
  }

  // BEGIN IMMEDIATE takes the write lock up front, so a concurrent writer
  // waits on busy_timeout instead of failing when it upgrades a read lock.
  private transaction<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.inTransaction !== false) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // SQLite already rolled back; surface the original error.
        }
      }
      throw error;
    }
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    return this.insert(input);
  }

  private insert(input: MemoryStoreInput): Memory {
    const now = new Date().toISOString();
    const id = input.id ?? this.generateId();

    this.db.prepare(
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
         touched_at = excluded.touched_at`
    ).run(
      id,
      input.actorId,
      input.memoryType ?? "interaction",
      input.content,
      input.importance ?? 0.5,
      input.emotionalValence ?? 0,
      JSON.stringify(input.tags ?? []),
      input.embedding ? JSON.stringify(input.embedding) : null,
      input.sourceId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.expiresAt?.toISOString() ?? null,
      now,
      now
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
    return this.transaction(() => inputs.map((input) => this.insert(input)));
  }

  async get(id: string): Promise<Memory | null> {
    const row = this.db.prepare(
      `SELECT * FROM ${this.table} WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)`
    ).get(id, new Date().toISOString()) as SqliteMemoryRow | undefined;

    if (!row) return null;
    return this._rowToMemory(row);
  }

  async delete(id: string): Promise<void> {
    const row = this.db.prepare(`SELECT id FROM ${this.table} WHERE id = ?`).get(id) as { id: string } | undefined;
    if (!row) throw notFound("Memory", id);
    this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    const placeholders = ids.map(() => "?").join(", ");
    const result = this.db.prepare(
      `DELETE FROM ${this.table} WHERE id IN (${placeholders})`
    ).run(...ids);
    return result.changes;
  }

  async touch(id: string): Promise<void> {
    const row = this.db.prepare(`SELECT id FROM ${this.table} WHERE id = ?`).get(id) as { id: string } | undefined;
    if (!row) throw notFound("Memory", id);
    this.db.prepare(`UPDATE ${this.table} SET touched_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const conditions: string[] = ["(expires_at IS NULL OR expires_at > ?)"];
    const params: unknown[] = [new Date().toISOString()];

    if (query.actorId) {
      conditions.push("actor_id = ?");
      params.push(query.actorId);
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      const placeholders = query.memoryTypes.map(() => "?").join(", ");
      conditions.push(`memory_type IN (${placeholders})`);
      params.push(...query.memoryTypes);
    }
    if (query.createdAfter) {
      conditions.push("created_at >= ?");
      params.push(query.createdAfter.toISOString());
    }
    if (query.createdBefore) {
      conditions.push("created_at <= ?");
      params.push(query.createdBefore.toISOString());
    }

    const hasSemantic = (query.strategy === "semantic" || query.strategy === "hybrid") && embedding && embedding.length > 0;

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
        if (hasSemantic) {
          orderBy = "touched_at DESC";
        } else {
          orderBy = "importance DESC, touched_at DESC";
        }
        break;
    }

    const limit = query.limit ?? 10;
    const sql = `SELECT * FROM ${this.table} WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy}`;
    let results = this.db.prepare(sql).all(...params) as SqliteMemoryRow[];

    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter((r) => r.content.toLowerCase().includes(q));
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter((r) => {
        const tags: string[] = JSON.parse(r.tags);
        return tags.some((t) => query.tags!.includes(t));
      });
    }

    if (hasSemantic && embedding) {
      const scored = results
        .filter((r) => r.embedding !== null)
        .map((r) => {
          const emb: number[] = JSON.parse(r.embedding!);
          const score = cosineSimilarity(embedding, emb);
          return { row: r, score };
        })
        .sort((a, b) => b.score - a.score);

      if (query.strategy === "hybrid") {
        scored.sort((a, b) => (b.score + b.row.importance) - (a.score + a.row.importance));
      }

      const topK = scored.slice(0, limit).map(({ row }) => row);
      this.touchRows(topK, query.touch);
      return topK.map((row) => this._rowToMemory(row));
    }

    const limited = results.slice(0, limit);
    this.touchRows(limited, query.touch);
    return limited.map((r) => this._rowToMemory(r));
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
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM ${this.table} WHERE ${where}`
    ).get(...params) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private touchRows(rows: SqliteMemoryRow[], touch: boolean | undefined): void {
    if (touch === false || rows.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE ${this.table} SET touched_at = ? WHERE id = ?`);
    this.transaction(() => {
      for (const row of rows) stmt.run(now, row.id);
    });
  }

  private _rowToMemory(row: SqliteMemoryRow): Memory {
    return {
      id: row.id,
      actorId: row.actor_id,
      memoryType: row.memory_type as MemoryType,
      content: row.content,
      importance: row.importance,
      emotionalValence: row.emotional_valence,
      tags: JSON.parse(row.tags),
      embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
      sourceId: row.source_id ?? undefined,
      metadata: JSON.parse(row.metadata),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
    };
  }
}
