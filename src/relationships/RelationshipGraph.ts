import type { Memory } from "../types.js";
import type { Relationship, RelationshipStage } from "../types.js";
import type {
  RelationshipSetInput,
  RelationshipDeltaInput,
  RelationshipFindFilter,
} from "../interfaces.js";
import { notFound, validationError } from "../errors.js";

export class RelationshipGraph {
  private relationships: Map<string, Relationship> = new Map();

  private key(actorA: string, actorB: string): string {
    return `${actorA}::${actorB}`;
  }

  private computeStage(affinity: number): RelationshipStage {
    if (affinity > 80) return "romantic";
    if (affinity > 60) return "close_friend";
    if (affinity > 30) return "friend";
    if (affinity > 10) return "acquaintance";
    if (affinity < -60) return "nemesis";
    if (affinity < -30) return "rival";
    return "stranger";
  }

  generateId(): string {
    return `rel_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
  }

  async set(actorA: string, actorB: string, data: RelationshipSetInput): Promise<Relationship> {
    if (!actorA || !actorB) throw validationError("actorA and actorB are required");
    if (actorA === actorB) throw validationError("Cannot create self-relationship");

    const k = this.key(actorA, actorB);
    const existing = this.relationships.get(k);
    const now = new Date();

    const affinity = data.affinity ?? existing?.affinity ?? 0;
    const stage = data.stage ?? (existing?.stage ?? this.computeStage(affinity));

    const rel: Relationship = {
      actorA,
      actorB,
      affinity: Math.max(-100, Math.min(100, affinity)),
      trust: Math.max(-100, Math.min(100, data.trust ?? existing?.trust ?? 0)),
      fear: Math.max(0, Math.min(100, data.fear ?? existing?.fear ?? 0)),
      respect: Math.max(0, Math.min(100, data.respect ?? existing?.respect ?? 0)),
      stage,
      interactionCount: (existing?.interactionCount ?? 0) + 1,
      historySummary: existing?.historySummary,
      tags: data.tags ?? existing?.tags ?? [],
      metadata: data.metadata ?? existing?.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.relationships.set(k, rel);
    return rel;
  }

  async updateDeltas(
    actorA: string,
    actorB: string,
    deltas: RelationshipDeltaInput
  ): Promise<Relationship> {
    const existing = this.relationships.get(this.key(actorA, actorB));
    if (!existing) throw notFound("Relationship", `${actorA}->${actorB}`);

    const newAffinity = existing.affinity + (deltas.affinity ?? 0);
    const newTrust = existing.trust + (deltas.trust ?? 0);
    const newFear = existing.fear + (deltas.fear ?? 0);
    const newRespect = existing.respect + (deltas.respect ?? 0);

    return this.set(actorA, actorB, {
      affinity: newAffinity,
      trust: newTrust,
      fear: newFear,
      respect: newRespect,
      stage: this.computeStage(newAffinity),
      tags: existing.tags,
      metadata: existing.metadata ?? {},
    });
  }

  async get(actorA: string, actorB: string): Promise<Relationship | null> {
    return this.relationships.get(this.key(actorA, actorB)) ?? null;
  }

  async getAll(actorId: string): Promise<Relationship[]> {
    const results: Relationship[] = [];
    for (const [k, rel] of this.relationships) {
      if (k.startsWith(`${actorId}::`)) {
        results.push(rel);
      }
    }
    return results;
  }

  async find(filter: RelationshipFindFilter): Promise<Relationship[]> {
    let results = Array.from(this.relationships.values());

    if (filter.actorId) {
      results = results.filter((r) => r.actorA === filter.actorId || r.actorB === filter.actorId);
    }
    if (filter.minAffinity !== undefined) {
      results = results.filter((r) => r.affinity >= filter.minAffinity!);
    }
    if (filter.maxAffinity !== undefined) {
      results = results.filter((r) => r.affinity <= filter.maxAffinity!);
    }
    if (filter.stage) {
      results = results.filter((r) => r.stage === filter.stage);
    }
    if (filter.tag) {
      const tag = filter.tag;
      results = results.filter((r) => r.tags.includes(tag));
    }

    return results;
  }

  async delete(actorA: string, actorB: string): Promise<void> {
    const k = this.key(actorA, actorB);
    if (!this.relationships.has(k)) throw notFound("Relationship", `${actorA}->${actorB}`);
    this.relationships.delete(k);
  }

  export(): Relationship[] {
    return Array.from(this.relationships.values());
  }

  import(relationships: Relationship[]): void {
    for (const rel of relationships) {
      this.relationships.set(this.key(rel.actorA, rel.actorB), rel);
    }
  }
}
