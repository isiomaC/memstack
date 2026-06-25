import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError, notFound } from "../../errors.js";

export interface MarkdownStorageConfig {
  dir: string;
  oneFilePerActor?: boolean;
}

export class MarkdownStorageAdapter implements StorageProvider {
  private dir: string;
  private oneFilePerActor: boolean;
  private _cache: Map<string, Memory> | null = null;
  private _deletedIds: Set<string> = new Set();
  private _cacheDirty: boolean = true;

  constructor(config: MarkdownStorageConfig) {
    this.dir = config.dir;
    this.oneFilePerActor = config.oneFilePerActor ?? true;
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
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

    const filePath = this._filePath(input.actorId);
    const block = this._formatBlock(memory);
    await appendFile(filePath, block, "utf-8");
    this._cacheDirty = true;
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
    await this._ensureCache();
    const memory = this._cache!.get(id);
    if (!memory) return null;
    if (memory.expiresAt && memory.expiresAt <= new Date()) return null;
    if (this._deletedIds.has(id)) return null;
    return memory;
  }

  async delete(id: string): Promise<void> {
    await this._ensureCache();
    const memory = this._cache!.get(id);
    if (!memory || this._deletedIds.has(id)) {
      throw notFound("Memory", id);
    }
    if (memory.expiresAt && memory.expiresAt <= new Date()) {
      throw notFound("Memory", id);
    }

    const filePath = this._filePath(memory.actorId);
    const tombstone = this._formatTombstone(id);
    await appendFile(filePath, tombstone, "utf-8");
    this._cacheDirty = true;
  }

  async deleteMany(ids: string[]): Promise<number> {
    await this._ensureCache();
    const idSet = new Set(ids);
    
    const toDelete: { id: string; actorId: string }[] = [];
    for (const id of ids) {
      const memory = this._cache!.get(id);
      if (memory && !this._deletedIds.has(id)) {
        if (!memory.expiresAt || memory.expiresAt > new Date()) {
          toDelete.push({ id, actorId: memory.actorId });
        }
      }
    }

    const byActor = new Map<string, string[]>();
    for (const { id, actorId } of toDelete) {
      const group = byActor.get(actorId) ?? [];
      group.push(id);
      byActor.set(actorId, group);
    }

    for (const [actorId, groupIds] of byActor) {
      const filePath = this._filePath(actorId);
      const blocks = groupIds.map((gid) => this._formatTombstone(gid)).join("");
      await appendFile(filePath, blocks, "utf-8");
    }

    this._cacheDirty = true;
    return toDelete.length;
  }

  async retrieve(query: MemoryRetrieveQuery, _embedding?: number[]): Promise<Memory[]> {
    await this._ensureCache();
    const now = new Date();
    let results = Array.from(this._cache!.values())
      .filter((m) => !this._deletedIds.has(m.id))
      .filter((m) => !m.expiresAt || m.expiresAt > now);

    if (query.actorId) {
      results = results.filter((m) => m.actorId === query.actorId);
    }
    if (query.memoryTypes && query.memoryTypes.length > 0) {
      results = results.filter((m) => query.memoryTypes!.includes(m.memoryType));
    }
    if (query.tags && query.tags.length > 0) {
      results = results.filter((m) => m.tags?.some((t) => query.tags!.includes(t)));
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter((m) => m.content.toLowerCase().includes(q));
    }

    switch (query.strategy) {
      case "recent":
        results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        break;
      case "important":
        results.sort((a, b) => b.importance - a.importance);
        break;
      case "hybrid":
      case "semantic":
      default:
        results.sort(
          (a, b) => b.importance - a.importance || b.createdAt.getTime() - a.createdAt.getTime()
        );
        break;
    }

    const limit = query.limit ?? 10;
    return results.slice(0, limit);
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    await this._ensureCache();
    const now = new Date();
    let results = Array.from(this._cache!.values())
      .filter((m) => !this._deletedIds.has(m.id))
      .filter((m) => !m.expiresAt || m.expiresAt > now);

    if (filter?.actorId) {
      results = results.filter((m) => m.actorId === filter.actorId);
    }
    if (filter?.memoryType) {
      results = results.filter((m) => m.memoryType === filter.memoryType);
    }
    if (filter?.minImportance !== undefined) {
      results = results.filter((m) => m.importance >= filter.minImportance!);
    }
    return results.length;
  }

  async close(): Promise<void> {
    this._cache = null;
    this._deletedIds.clear();
    this._cacheDirty = true;
  }

  async vacuum(): Promise<void> {
    if (this.oneFilePerActor) {
      const actorIds = await this._listActors();
      for (const actorId of actorIds) {
        await this._vacuumFile(this._filePath(actorId));
      }
    } else {
      await this._vacuumFile(this._filePath(""));
    }
    this._cacheDirty = true;
  }

  // ── Internal ──

  private _filePath(actorId: string): string {
    if (!this.oneFilePerActor) {
      return join(this.dir, "memories.md");
    }
    const safe = actorId.replace(/[^a-zA-Z0-9_\-.,@]/g, "_");
    return join(this.dir, `${safe}.md`);
  }

  private _formatBlock(memory: Memory): string {
    const iso = memory.createdAt.toISOString();
    const meta = JSON.stringify({
      id: memory.id,
      actorId: memory.actorId,
      memoryType: memory.memoryType,
      importance: memory.importance,
      emotionalValence: memory.emotionalValence,
      tags: memory.tags,
      embedding: memory.embedding,
      sourceId: memory.sourceId ?? null,
      metadata: memory.metadata ?? {},
      createdAt: memory.createdAt.toISOString(),
      expiresAt: memory.expiresAt?.toISOString() ?? null,
    });
    return `## ${iso}\n\n~~~json\n${meta}\n~~~\n\n${memory.content}\n\n---\n`;
  }

  private _formatTombstone(id: string): string {
    const iso = new Date().toISOString();
    return `## ${iso}\n\n<!-- deleted: ${id} -->\n\n---\n`;
  }

  private async _ensureCache(): Promise<void> {
    if (!this._cacheDirty) return;

    const allMemories = new Map<string, Memory>();
    const allDeletedIds = new Set<string>();

    if (this.oneFilePerActor) {
      const actorIds = await this._listActors();
      for (const actorId of actorIds) {
        const { memories, deletedIds } = await this._parseFile(this._filePath(actorId));
        for (const mem of memories) {
          allMemories.set(mem.id, mem);
        }
        for (const did of deletedIds) {
          allDeletedIds.add(did);
        }
      }
    } else {
      const { memories, deletedIds } = await this._parseFile(this._filePath(""));
      for (const mem of memories) {
        allMemories.set(mem.id, mem);
      }
      for (const did of deletedIds) {
        allDeletedIds.add(did);
      }
    }

    this._cache = allMemories;
    this._deletedIds = allDeletedIds;
    this._cacheDirty = false;
  }

  private async _parseFile(filePath: string): Promise<{ memories: Memory[]; deletedIds: string[] }> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { memories: [], deletedIds: [] };
      }
      throw storageError(`Failed to read file ${filePath}: ${(err as Error).message}`);
    }

    const memories: Memory[] = [];
    const deletedIds: string[] = [];

    const sections = raw.split("\n---\n");

    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed) continue;

      const cleanBlock = trimmed.replace(/\n---$/, "");
      const lines = cleanBlock.split("\n");
      let i = 0;

      if (!lines[i]?.startsWith("## ")) continue;
      i++;

      while (i < lines.length && lines[i].trim() === "") i++;
      if (i >= lines.length) continue;

      const tombstoneMatch = lines[i].trim().match(/^<!-- deleted:\s*(\S+)\s*-->/);
      if (tombstoneMatch) {
        deletedIds.push(tombstoneMatch[1]);
        continue;
      }

      if (lines[i].trim() !== "~~~json") continue;
      i++;

      const jsonLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "~~~") {
        jsonLines.push(lines[i]);
        i++;
      }
      i++;

      let metadata: Record<string, unknown> | null = null;
      try {
        metadata = JSON.parse(jsonLines.join("\n"));
      } catch {
        continue;
      }

      while (i < lines.length && lines[i].trim() === "") i++;

      const contentLines: string[] = [];
      while (i < lines.length) {
        contentLines.push(lines[i]);
        i++;
      }
      const content = contentLines.join("\n").trim();

      if (metadata && typeof metadata.id === "string") {
        memories.push({
          id: metadata.id,
          actorId: metadata.actorId as string,
          memoryType: (metadata.memoryType as MemoryType) ?? "interaction",
          content,
          importance: (metadata.importance as number) ?? 0.5,
          emotionalValence: (metadata.emotionalValence as number) ?? 0,
          tags: (metadata.tags as string[]) ?? [],
          embedding: metadata.embedding as number[] | undefined,
          sourceId: (metadata.sourceId as string | undefined) ?? undefined,
          metadata: (metadata.metadata as Record<string, unknown>) ?? {},
          createdAt: new Date(metadata.createdAt as string),
          expiresAt: metadata.expiresAt ? new Date(metadata.expiresAt as string) : undefined,
        });
      }
    }

    return { memories, deletedIds };
  }

  private async _vacuumFile(filePath: string): Promise<void> {
    await this._ensureCache();

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw storageError(`Failed to read file for vacuum: ${(err as Error).message}`);
    }

    const sections = raw.split("\n---\n");
    const kept: string[] = [];

    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed) continue;

      const cleanBlock = trimmed.replace(/\n---$/, "");
      const lines = cleanBlock.split("\n");
      let i = 0;

      if (!lines[i]?.startsWith("## ")) {
        kept.push(trimmed);
        continue;
      }
      i++;

      while (i < lines.length && lines[i].trim() === "") i++;
      if (i >= lines.length) {
        kept.push(trimmed);
        continue;
      }

      const tombstoneMatch = lines[i].trim().match(/^<!-- deleted:\s*(\S+)\s*-->/);
      if (tombstoneMatch) continue;

      if (lines[i].trim() !== "~~~json") {
        kept.push(trimmed);
        continue;
      }
      i++;

      while (i < lines.length && lines[i].trim() !== "~~~") i++;
      i++;

      while (i < lines.length && lines[i].trim() === "") i++;

      const contentLines: string[] = [];
      while (i < lines.length) {
        contentLines.push(lines[i]);
        i++;
      }

      try {
        const jsonStartIdx = lines.findIndex((l) => l.trim() === "~~~json");
        const jsonEndIdx = lines.findIndex((l, idx) => idx > jsonStartIdx && l.trim() === "~~~");
        const jsonText = lines.slice(jsonStartIdx + 1, jsonEndIdx).join("\n");
        const meta = JSON.parse(jsonText);
        if (this._deletedIds.has(meta.id)) continue;
      } catch {
        // Keep block if we can't parse its metadata
      }

      const content = contentLines.join("\n").trim();
      if (content || trimmed.includes("~~~json")) {
        kept.push(trimmed);
      }
    }

    const output = kept.length > 0 ? kept.join("\n---\n") + "\n---\n" : "";
    await writeFile(filePath, output, "utf-8");
  }

  private async _listActors(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries.filter((e) => e.endsWith(".md")).map((e) => e.slice(0, -3));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw storageError(`Failed to list actors: ${(err as Error).message}`);
    }
  }
}
