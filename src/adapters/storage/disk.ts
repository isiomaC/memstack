import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
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

export class DiskStorage implements StorageProvider {
  private dir: string;
  private _writeLocks = new Map<string, Promise<void>>();

  constructor(config: DiskStorageConfig = {}) {
    this.dir = config.storageDir ?? "./memstack-data";
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
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
      createdAt: now,
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
        createdAt: now,
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
        }
        await this._writeFile(actorId, existing);
      });
    }

    return all.map((m) => this._toExternal(m));
  }

  async get(id: string): Promise<Memory | null> {
    const actorIds = await this._listActors();
    for (const actorId of actorIds) {
      const records = await this._readFile(actorId);
      const record = records.find((r) => r.id === id);
      if (record) {
        if (record.expiresAt && new Date(record.expiresAt) <= new Date()) return null;
        return this._toExternal(record);
      }
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    const actorIds = await this._listActors();
    for (const actorId of actorIds) {
      const records = await this._readFile(actorId);
      const index = records.findIndex((r) => r.id === id);
      if (index !== -1) {
        await this._withWriteLock(actorId, async () => {
          const fresh = await this._readFile(actorId);
          const i = fresh.findIndex((r) => r.id === id);
          if (i !== -1) {
            fresh.splice(i, 1);
            await this._writeFile(actorId, fresh);
          }
        });
        return;
      }
    }
    throw notFound("Memory", id);
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
        const q = query.query.toLowerCase();
        records = records.filter((r) => r.content.toLowerCase().includes(q));
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
    const actorIds = await this._listActors();
    for (const actorId of actorIds) {
      const records = await this._readFile(actorId);
      const found = records.find((r) => r.id === id);
      if (found) {
        const nowStr = new Date().toISOString();
        await this._withWriteLock(actorId, async () => {
          const fresh = await this._readFile(actorId);
          const match = fresh.find((r) => r.id === id);
          if (match) {
            match._touchedAt = nowStr;
            await this._writeFile(actorId, fresh);
          }
        });
        return;
      }
    }
    throw notFound("Memory", id);
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
    try {
      await writeFile(this._filePath(actorId), JSON.stringify(records, null, 2), "utf-8");
    } catch (err) {
      throw storageError(`Failed to write memories for actor ${actorId}: ${(err as Error).message}`);
    }
  }

  private async _withWriteLock(actorId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this._writeLocks.get(actorId) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this._writeLocks.set(actorId, next);
    await prev;
    try {
      await fn();
    } finally {
      resolve();
      // Clean up: only remove this entry if it hasn't been replaced by a newer lock
      if (this._writeLocks.get(actorId) === next) {
        this._writeLocks.delete(actorId);
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

  private _toExternal(record: MemoryRecord): Memory {
    const { _touchedAt: _, ...rest } = record;
    return {
      ...rest,
      createdAt: new Date(record.createdAt),
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : undefined,
    };
  }
}
