import type { Memory, MemorySource, MemoryType } from "../types.js";
import type { LLMProvider, StorageProvider } from "../interfaces.js";
import { LexicalRetriever } from "../retrieval/LexicalRetriever.js";
import type { RecallResult } from "../retrieval/LexicalRetriever.js";
import { ENRICHMENT_MAX_TOKENS, parseTags } from "../enrichment.js";
import { MemStackError, notFound, validationError } from "../errors.js";
import { projectNamespace } from "./namespaces.js";

export interface HarnessMemoryConfig {
  storage: StorageProvider;
  llm: LLMProvider;
  /** Ask the LLM for topic tags on every write. Default true. */
  autoTags?: boolean;
  /** Give up on tagging after this long and store the memory untagged. Default 10000. */
  tagTimeoutMs?: number;
  /** Longest content accepted by `remember`. Default 8000 characters. */
  maxContentChars?: number;
  /** Memories ranked per namespace on recall. Default 2000. */
  candidateLimit?: number;
  /** Called when tagging fails; the memory is still stored. */
  onError?: (error: Error, context: string) => void;
}

export interface RememberInput {
  /** Namespace to write to, used as `actorId`, e.g. `project:<id>` or `global`. */
  namespace: string;
  content: string;
  kind?: MemoryType;
  importance?: number;
  tags?: string[];
  source: MemorySource;
}

export interface HarnessRecallInput {
  /** Namespaces to search together, e.g. `["project:<id>", "global"]`. */
  namespaces: string[];
  query?: string;
  kinds?: MemoryType[];
  limit?: number;
  maxChars?: number;
}

const MAX_TAGS = 8;

const TAG_PROMPT =
  "You tag memories so they can be found later by keyword search. Return 3-5 lowercase, " +
  "single-word topic tags as a JSON array of strings, and nothing else. Include broader " +
  "category words a person might search for, not only words already in the text. " +
  'Example: for "This project uses Hono" return ["framework", "backend", "web", "server", "hono"].';

/**
 * Memory operations for agent harnesses such as Claude Code and Codex.
 * Works on any storage adapter. Every read and delete is limited to the
 * namespaces the caller passes, so one project cannot see another's memories.
 * Recall never calls the LLM; only `remember` does, for tagging.
 */
export class HarnessMemory {
  private storage: StorageProvider;
  private llm: LLMProvider;
  private retriever: LexicalRetriever;
  private autoTags: boolean;
  private tagTimeoutMs: number;
  private maxContentChars: number;
  private onError?: (error: Error, context: string) => void;
  private initialized?: Promise<void>;

  constructor(config: HarnessMemoryConfig) {
    this.storage = config.storage;
    this.llm = config.llm;
    this.retriever = new LexicalRetriever(config.storage, { candidateLimit: config.candidateLimit });
    this.autoTags = config.autoTags ?? true;
    this.tagTimeoutMs = config.tagTimeoutMs ?? 10_000;
    this.maxContentChars = config.maxContentChars ?? 8000;
    this.onError = config.onError;
  }

  async remember(input: RememberInput): Promise<Memory> {
    const content = input.content.trim();
    if (!content) throw validationError("Memory content is empty");
    if (content.length > this.maxContentChars) {
      throw validationError(`Memory content is longer than ${this.maxContentChars} characters`, {
        length: content.length,
      });
    }
    if (!input.namespace) throw validationError("Namespace is required");
    if (input.importance !== undefined && !(input.importance >= 0 && input.importance <= 1)) {
      throw validationError("Importance must be between 0 and 1", { importance: input.importance });
    }

    await this.ensureInit();
    const llmTags = this.autoTags ? await this.suggestTags(content) : [];
    const tags = [...new Set([...(input.tags ?? []), ...llmTags].map((t) => t.toLowerCase().trim()).filter(Boolean))];

    return this.storage.store({
      actorId: input.namespace,
      content,
      memoryType: input.kind ?? "observation",
      importance: input.importance ?? 0.5,
      tags: tags.slice(0, MAX_TAGS),
      metadata: { source: input.source },
    });
  }

  async recall(input: HarnessRecallInput): Promise<RecallResult> {
    await this.ensureInit();
    return this.retriever.recall({
      actorIds: input.namespaces,
      query: input.query,
      memoryTypes: input.kinds,
      limit: input.limit,
      maxChars: input.maxChars,
    });
  }

  /** The memory with this ID, or null when it does not exist or is outside `namespaces`. */
  async get(id: string, namespaces: string[]): Promise<Memory | null> {
    await this.ensureInit();
    const memory = await this.storage.get(id);
    return memory && namespaces.includes(memory.actorId) ? memory : null;
  }

  /** Delete a memory. Memories outside `namespaces` are reported as not found. */
  async forget(id: string, namespaces: string[]): Promise<void> {
    const memory = await this.get(id, namespaces);
    if (!memory) throw notFound("Memory", id);
    await this.storage.delete(id);
  }

  /** Number of memories in each namespace. */
  async stats(namespaces: string[]): Promise<Record<string, number>> {
    await this.ensureInit();
    const counts: Record<string, number> = {};
    for (const namespace of new Set(namespaces)) {
      counts[namespace] = await this.storage.count({ actorId: namespace });
    }
    return counts;
  }

  /**
   * Moves every memory from one namespace to another, keeping content,
   * kind, importance, tags, provenance, and creation time. Memories get new
   * IDs. Used when a project's ID changes, e.g. after its first commit.
   * Safe to run from two processes at once: a copy whose original was
   * already moved by the other process is removed again.
   */
  async moveNamespace(from: string, to: string): Promise<number> {
    if (!from || !to) throw validationError("Both namespaces are required");
    if (from === to) return 0;
    await this.ensureInit();
    let moved = 0;
    for (;;) {
      const batch = await this.storage.retrieve({ actorId: from, limit: 500, strategy: "recent", touch: false });
      if (batch.length === 0) return moved;
      let progressed = false;
      for (const memory of batch) {
        const copy = await this.storage.store({
          actorId: to,
          content: memory.content,
          memoryType: memory.memoryType,
          importance: memory.importance,
          emotionalValence: memory.emotionalValence,
          tags: memory.tags,
          metadata: memory.metadata,
          createdAt: memory.createdAt,
          expiresAt: memory.expiresAt,
        });
        try {
          await this.storage.delete(memory.id);
          moved++;
          progressed = true;
        } catch (error) {
          await this.storage.delete(copy.id);
          if (!(error instanceof MemStackError && error.code === "NOT_FOUND")) throw error;
        }
      }
      if (!progressed) return moved;
    }
  }

  /**
   * Adopts memories a project stored under IDs it had before, such as
   * before its first commit. Costs one count per previous ID when there is
   * nothing to move. Returns the number of memories moved.
   */
  async adoptProjects(previousIds: string[], projectId: string): Promise<number> {
    const target = projectNamespace(projectId);
    let moved = 0;
    for (const id of new Set(previousIds)) {
      const from = projectNamespace(id);
      if (from === target) continue;
      await this.ensureInit();
      if ((await this.storage.count({ actorId: from })) === 0) continue;
      moved += await this.moveNamespace(from, target);
    }
    return moved;
  }

  private ensureInit(): Promise<void> {
    this.initialized ??= this.storage.initialize().catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async suggestTags(content: string): Promise<string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tagging timed out after ${this.tagTimeoutMs} ms`)), this.tagTimeoutMs);
      });
      const result = await Promise.race([
        this.llm.complete({ system: TAG_PROMPT, user: content, maxTokens: ENRICHMENT_MAX_TOKENS, temperature: 0 }),
        timeout,
      ]);
      if (!result.text.trim()) throw new Error("Tagging returned an empty reply");
      return parseTags(result.text).filter((t) => /^[\p{L}\p{N}-]+$/u.test(t));
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)), "harness-tagging");
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
