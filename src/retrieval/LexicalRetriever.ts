import type { Memory, MemoryType } from "../types.js";
import type { StorageProvider } from "../interfaces.js";
import { documentTerms, queryTerms } from "./text.js";

export interface RecallQuery {
  /** Namespaces to recall from, matched exactly against `actorId`, e.g. `["project:abc", "global"]`. */
  actorIds: string[];
  /** Free text. When empty or without words, recall returns the fallback. */
  query?: string;
  memoryTypes?: MemoryType[];
  /** Maximum memories returned. Default 10. */
  limit?: number;
  /** Maximum total characters of returned content. The top result is always returned. Default 8000. */
  maxChars?: number;
}

export interface RecallHit {
  memory: Memory;
  /** BM25 score, or 0 for fallback results. */
  score: number;
}

export interface RecallResult {
  hits: RecallHit[];
  /** True when nothing matched the query and the hits are the most important and recent memories. */
  fallback: boolean;
}

export interface LexicalRetrieverConfig {
  /** Memories loaded per namespace for ranking, most important first. Default 2000. */
  candidateLimit?: number;
  /** Mark returned memories as accessed via `storage.touch`. Default true. */
  touch?: boolean;
}

// BM25 parameters; the usual defaults.
const K1 = 1.2;
const B = 0.75;
// A query term that only prefixes a document term ("hon" for "hono") scores at this weight.
const PREFIX_WEIGHT = 0.5;
const MIN_PREFIX_LENGTH = 3;

interface Candidate {
  memory: Memory;
  terms: Map<string, number>;
  length: number;
}

/**
 * Recall that works on every storage adapter: memories in scope are loaded
 * through `StorageProvider.retrieve` and ranked in Core with BM25 over
 * content and tags. Adapters with native `search()` are used instead when
 * they declare `textSearch`. Recall never calls an LLM.
 */
export class LexicalRetriever {
  private candidateLimit: number;
  private touch: boolean;

  constructor(private storage: StorageProvider, config: LexicalRetrieverConfig = {}) {
    this.candidateLimit = config.candidateLimit ?? 2000;
    this.touch = config.touch ?? true;
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    const limit = query.limit ?? 10;
    const maxChars = query.maxChars ?? 8000;
    const terms = queryTerms(query.query ?? "");

    let ranked: RecallHit[] = [];
    let candidates: Memory[] | undefined;

    if (terms.length > 0 && this.storage.search && this.storage.capabilities?.textSearch) {
      ranked = (await this.storage.search({
        actorIds: query.actorIds,
        query: query.query!,
        memoryTypes: query.memoryTypes,
        limit: this.candidateLimit,
      })).map(({ memory, score }) => ({ memory, score }));
    } else if (terms.length > 0) {
      candidates = await this.loadCandidates(query);
      ranked = rank(candidates, terms);
    }

    const fallback = ranked.length === 0;
    if (fallback) {
      candidates ??= await this.loadCandidates(query);
      ranked = [...candidates].sort(byImportanceThenRecency).map((memory) => ({ memory, score: 0 }));
    }

    const hits = withinBudget(ranked, limit, maxChars);
    if (this.touch) await this.touchAll(hits);
    return { hits, fallback };
  }

  private async loadCandidates(query: RecallQuery): Promise<Memory[]> {
    const byId = new Map<string, Memory>();
    for (const actorId of new Set(query.actorIds)) {
      const memories = await this.storage.retrieve({
        actorId,
        memoryTypes: query.memoryTypes,
        limit: this.candidateLimit,
        strategy: "important",
        touch: false,
      });
      for (const memory of memories) byId.set(memory.id, memory);
    }
    return [...byId.values()];
  }

  private async touchAll(hits: RecallHit[]): Promise<void> {
    if (!this.storage.touch) return;
    await Promise.all(
      hits.map(({ memory }) =>
        this.storage.touch!(memory.id).catch(() => {
          // Deleted by another process since it was loaded; nothing to mark.
        })
      )
    );
  }
}

function rank(memories: Memory[], terms: string[]): RecallHit[] {
  if (memories.length === 0) return [];
  const candidates: Candidate[] = memories.map((memory) => {
    const tokens = documentTerms(`${memory.content} ${memory.tags.join(" ")}`);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { memory, terms: counts, length: tokens.length };
  });

  const avgLength = candidates.reduce((sum, c) => sum + c.length, 0) / candidates.length || 1;
  const n = candidates.length;

  // Frequency of each query term per candidate: exact matches count fully, prefix matches partially.
  const frequencies = terms.map((term) =>
    candidates.map((c) => {
      let tf = c.terms.get(term) ?? 0;
      if (term.length >= MIN_PREFIX_LENGTH) {
        for (const [docTerm, count] of c.terms) {
          if (docTerm !== term && docTerm.startsWith(term)) tf += count * PREFIX_WEIGHT;
        }
      }
      return tf;
    })
  );

  const hits: RecallHit[] = [];
  candidates.forEach((c, i) => {
    let score = 0;
    frequencies.forEach((perCandidate) => {
      const tf = perCandidate[i];
      if (tf === 0) return;
      const df = perCandidate.filter((f) => f > 0).length;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * c.length) / avgLength)));
    });
    if (score > 0) hits.push({ memory: c.memory, score });
  });

  return hits.sort((a, b) => b.score - a.score || byImportanceThenRecency(a.memory, b.memory));
}

function byImportanceThenRecency(a: Memory, b: Memory): number {
  return b.importance - a.importance || b.createdAt.getTime() - a.createdAt.getTime();
}

function withinBudget(ranked: RecallHit[], limit: number, maxChars: number): RecallHit[] {
  const hits: RecallHit[] = [];
  let chars = 0;
  for (const hit of ranked) {
    if (hits.length >= limit) break;
    const size = hit.memory.content.length;
    if (hits.length > 0 && chars + size > maxChars) continue;
    hits.push(hit);
    chars += size;
  }
  return hits;
}
