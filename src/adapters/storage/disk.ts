import { mkdir, readFile, writeFile, readdir, open, unlink, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError, notFound } from "../../errors.js";

interface MemoryRecord extends Memory {
  _touchedAt: string;
}

export interface DiskStorageConfig {
  /** Directory to store memory files. Default: "./memstack-data" */
  storageDir?: string;
}

export class DiskStorageAdapter implements StorageProvider {
  private dir: string;
  private _writeLocks = new Map<string, Promise<void>>();
  private _idIndex = new Map<string, string>();

  constructor(config: DiskStorageConfig = {}) {
    this.dir = config.storageDir ?? "./memstack-data";
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this._buildIndex();
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const now = new Date();
    const memory: MemoryRecord = {
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
      _touchedAt: now.toISOString(),
    };

    await this._withWriteLock(input.actorId, async () => {
      const records = await this._readFile(input.actorId);
      const existingIdx = records.findIndex((r) => r.id === memory.id);
      if (existingIdx !== -1) {
        records[existingIdx] = memory;
      } else {
        records.push(memory);
      }
      this._idIndex.set(memory.id, input.actorId);
      await this._writeFile(input.actorId, records);
    });

    return this._toExternal(memory);
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const byActor = new Map<string, MemoryRecord[]>();
    const now = new Date();
    const all: MemoryRecord[] = [];

    for (const input of inputs) {
      const memory: MemoryRecord = {
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
        _touchedAt: now.toISOString(),
      };
      all.push(memory);
      const group = byActor.get(input.actorId) ?? [];
      group.push(memory);
      byActor.set(input.actorId, group);
    }

    for (const [actorId, group] of byActor) {
      await this._withWriteLock(actorId, async () => {
        const existing = await this._readFile(actorId);
        for (const mem of group) {
          const existingIdx = existing.findIndex((r) => r.id === mem.id);
          if (existingIdx !== -1) {
            existing[existingIdx] = mem;
          } else {
            existing.push(mem);
          }
          this._idIndex.set(mem.id, actorId);
        }
        await this._writeFile(actorId, existing);
      });
    }

    return all.map((m) => this._toExternal(m));
  }

  async get(id: string): Promise<Memory | null> {
    const actorId = this._idIndex.get(id);
    if (actorId) {
      const records = await this._readFile(actorId);
      const record = records.find((r) => r.id === id);
      if (record) {
        if (record.expiresAt && new Date(record.expiresAt) <= new Date()) return null;
        return this._toExternal(record);
      }
    }
    const actorIds = await this._listActors();
    for (const aid of actorIds) {
      const records = await this._readFile(aid);
      const record = records.find((r) => r.id === id);
      if (record) {
        this._idIndex.set(id, aid);
        if (record.expiresAt && new Date(record.expiresAt) <= new Date()) return null;
        return this._toExternal(record);
      }
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    let actorId = this._idIndex.get(id);
    if (!actorId) {
      const actorIds = await this._listActors();
      for (const aid of actorIds) {
        const records = await this._readFile(aid);
        if (records.some((r) => r.id === id)) { actorId = aid; break; }
      }
    }
    if (!actorId) throw notFound("Memory", id);

    let deleted = false;
    await this._withWriteLock(actorId, async () => {
      const fresh = await this._readFile(actorId);
      const i = fresh.findIndex((r) => r.id === id);
      if (i !== -1) {
        fresh.splice(i, 1);
        this._idIndex.delete(id);
        await this._writeFile(actorId, fresh);
        deleted = true;
      }
    });

    if (!deleted) throw notFound("Memory", id);
  }

  async deleteMany(ids: string[]): Promise<number> {
    const idSet = new Set(ids);
    let count = 0;
    const actorIds = await this._listActors();

    for (const actorId of actorIds) {
      await this._withWriteLock(actorId, async () => {
        const records = await this._readFile(actorId);
        const before = records.length;
        const filtered = records.filter((r) => !idSet.has(r.id));
        count += before - filtered.length;
        if (before !== filtered.length) {
          for (const r of records) {
            if (idSet.has(r.id)) this._idIndex.delete(r.id);
          }
          await this._writeFile(actorId, filtered);
        }
      });
    }

    return count;
  }

  async retrieve(query: MemoryRetrieveQuery, _embedding?: number[]): Promise<Memory[]> {
    const actorIds = query.actorId ? [query.actorId] : await this._listActors();
    let results: MemoryRecord[] = [];

    for (const actorId of actorIds) {
      let records = await this._readFile(actorId);
      const now = new Date();
      records = records.filter((r) => !r.expiresAt || new Date(r.expiresAt) > now);

      if (query.memoryTypes && query.memoryTypes.length > 0) {
        records = records.filter((r) => query.memoryTypes!.includes(r.memoryType));
      }
      if (query.tags && query.tags.length > 0) {
        records = records.filter((r) => r.tags?.some((t) => query.tags!.includes(t)));
      }
      if (query.query) {
        const terms = query.query.toLowerCase().split(/\s+/).filter(Boolean);
        records = records.filter((r) => {
          const content = r.content.toLowerCase();
          return terms.some((t) => content.includes(t));
        });
      }

      results.push(...records);
    }

    switch (query.strategy) {
      case "recent":
        results.sort((a, b) => new Date(b._touchedAt).getTime() - new Date(a._touchedAt).getTime());
        break;
      case "important":
        results.sort((a, b) => b.importance - a.importance);
        break;
      case "hybrid":
      case "semantic":
      default:
        results.sort(
          (a, b) =>
            b.importance - a.importance || new Date(b._touchedAt).getTime() - new Date(a._touchedAt).getTime()
        );
        break;
    }

    // Touch records on retrieval
    const nowStr = new Date().toISOString();
    const toTouch = results.slice(0, query.limit ?? 10);
    const touchedActors = new Set<string>();
    for (const r of toTouch) {
      r._touchedAt = nowStr;
      touchedActors.add(r.actorId);
    }
    // Persist touches back to disk
    for (const actorId of touchedActors) {
      await this._withWriteLock(actorId, async () => {
        const records = await this._readFile(actorId);
        let changed = false;
        for (const r of records) {
          const touched = toTouch.find((t) => t.id === r.id);
          if (touched) { r._touchedAt = nowStr; changed = true; }
        }
        if (changed) await this._writeFile(actorId, records);
      });
    }

    const limit = query.limit ?? 10;
    return results.slice(0, limit).map((r) => this._toExternal(r));
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const actorIds = filter?.actorId ? [filter.actorId] : await this._listActors();
    let total = 0;
    const now = new Date();

    for (const actorId of actorIds) {
      let records = await this._readFile(actorId);
      records = records.filter((r) => !r.expiresAt || new Date(r.expiresAt) > now);

      if (filter?.memoryType) {
        records = records.filter((r) => r.memoryType === filter.memoryType);
      }
      if (filter?.minImportance !== undefined) {
        records = records.filter((r) => r.importance >= filter.minImportance!);
      }
      total += records.length;
    }

    return total;
  }

  async touch(id: string): Promise<void> {
    const actorId = this._idIndex.get(id);
    if (!actorId) throw notFound("Memory", id);

    const nowStr = new Date().toISOString();
    await this._withWriteLock(actorId, async () => {
      const fresh = await this._readFile(actorId);
      const match = fresh.find((r) => r.id === id);
      if (!match) throw notFound("Memory", id);
      match._touchedAt = nowStr;
      await this._writeFile(actorId, fresh);
    });
  }

  async close(): Promise<void> {
    this._writeLocks.clear();
  }

  // ── Internal ──

  private _filePath(actorId: string): string {
    const safe = actorId.replace(/[^a-zA-Z0-9_\-.,@]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  private async _readFile(actorId: string): Promise<MemoryRecord[]> {
    try {
      const raw = await readFile(this._filePath(actorId), "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as MemoryRecord[]) : [];
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw storageError(`Failed to read memories for actor ${actorId}: ${(err as Error).message}`);
    }
  }

  private async _writeFile(actorId: string, records: MemoryRecord[]): Promise<void> {
    const filePath = this._filePath(actorId);
    // Write-then-rename instead of an in-place write: `rename` is atomic on
    // POSIX filesystems, so a concurrent reader (get/retrieve, which don't
    // take the write lock) never observes a partially-written file.
    const tmpPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(records, null, 2), "utf-8");
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw storageError(`Failed to write memories for actor ${actorId}: ${(err as Error).message}`);
    }
  }

  private async _withWriteLock(actorId: string, fn: () => Promise<void>): Promise<void> {
    // In-process serialization: cheap, and avoids every same-process caller
    // hitting the cross-process lockfile's retry loop for no reason.
    const prev = this._writeLocks.get(actorId) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this._writeLocks.set(actorId, next);
    await prev;
    // Cross-process serialization: the in-process chain above only protects
    // callers sharing this adapter instance. Separate OS processes (e.g. two
    // `memstack` CLI invocations, or multiple server workers) each have their
    // own instance and their own copy of `_writeLocks`, so without this an
    // interleaved read-modify-write across processes silently loses updates.
    const releaseFileLock = await this._acquireFileLock(actorId);
    try {
      await fn();
    } finally {
      await releaseFileLock();
      resolve();
      // Clean up: only remove this entry if it hasn't been replaced by a newer lock
      if (this._writeLocks.get(actorId) === next) {
        this._writeLocks.delete(actorId);
      }
    }
  }

  /**
   * Acquires an exclusive cross-process lock for `actorId` via `open(path, "wx")`
   * (atomic create-if-absent). Retries with jittered backoff while the lock is
   * held elsewhere, and steals locks left behind by a crashed process once
   * they're older than `staleMs`.
   */
  private async _acquireFileLock(actorId: string): Promise<() => Promise<void>> {
    const lockPath = `${this._filePath(actorId)}.lock`;
    const staleMs = 10_000;
    const timeoutMs = 30_000;
    const start = Date.now();

    while (true) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.close();
        return async () => {
          await unlink(lockPath).catch(() => {});
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw storageError(`Failed to acquire lock for actor ${actorId}: ${(err as Error).message}`);
        }
        try {
          const st = await stat(lockPath);
          if (Date.now() - st.mtimeMs > staleMs) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          continue; // lock file disappeared between EEXIST and stat — retry immediately
        }
        if (Date.now() - start > timeoutMs) {
          throw storageError(`Timed out waiting for disk storage lock: ${lockPath}`);
        }
        await new Promise((r) => setTimeout(r, 15 + Math.random() * 35));
      }
    }
  }

  private async _listActors(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -5));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw storageError(`Failed to list actors: ${(err as Error).message}`);
    }
  }

  private async _buildIndex(): Promise<void> {
    const actorIds = await this._listActors();
    for (const actorId of actorIds) {
      const records = await this._readFile(actorId);
      for (const r of records) {
        this._idIndex.set(r.id, actorId);
      }
    }
  }

  private _toExternal(record: MemoryRecord): Memory {
    const { _touchedAt: _, ...rest } = record;
    return {
      ...rest,
      createdAt: new Date(record.createdAt),
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : undefined,
    };
  }
}
