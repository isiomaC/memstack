// Harness memory conformance: the behaviour Claude Code and Codex rely on,
// checked against any StorageProvider. Run from unit tests for local
// adapters and from the e2e suite for server backends.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StorageProvider } from "../../src/interfaces.js";
import { LexicalRetriever } from "../../src/retrieval/LexicalRetriever.js";

export interface ConformanceTarget {
  storage: StorageProvider;
  teardown?: () => Promise<void>;
}

export function runHarnessConformance(name: string, setup: () => Promise<ConformanceTarget>): void {
  describe(`harness conformance: ${name}`, () => {
    let target: ConformanceTarget;
    let retriever: LexicalRetriever;
    let run = 0;
    // Fresh namespaces per test, so shared databases need no cleanup between tests.
    const ns = () => {
      const id = `${Date.now().toString(36)}${(run++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      return { project: `project:${id}`, other: `project:${id}-other`, global: `global-${id}` };
    };

    beforeAll(async () => {
      target = await setup();
      await target.storage.initialize();
      retriever = new LexicalRetriever(target.storage);
    });

    afterAll(async () => {
      await target?.teardown?.();
    });

    it("recalls a memory by a natural question", async () => {
      const { project } = ns();
      await target.storage.store({ actorId: project, content: "This project uses Hono", tags: ["framework", "backend"] });
      await target.storage.store({ actorId: project, content: "Validation uses Zod", tags: ["validation"] });
      await target.storage.store({ actorId: project, content: "Deploys run on Fridays" });

      const { hits, fallback } = await retriever.recall({ actorIds: [project], query: "What framework does this project use?" });
      expect(fallback).toBe(false);
      expect(hits[0].memory.content).toBe("This project uses Hono");
    });

    it("matches word stems", async () => {
      const { project } = ns();
      await target.storage.store({ actorId: project, content: "The integration tests are running in CI" });
      await target.storage.store({ actorId: project, content: "Prefer small pull requests" });

      const { hits } = await retriever.recall({ actorIds: [project], query: "run test" });
      expect(hits.map((h) => h.memory.content)).toEqual(["The integration tests are running in CI"]);
    });

    it("does not leak memories between projects", async () => {
      const { project, other } = ns();
      await target.storage.store({ actorId: other, content: "The other project uses Express" });
      await target.storage.store({ actorId: project, content: "This project uses Hono" });

      const { hits } = await retriever.recall({ actorIds: [project], query: "express hono" });
      expect(hits.map((h) => h.memory.actorId)).toEqual([project]);

      const fallback = await retriever.recall({ actorIds: [project], query: "nothing matches this" });
      expect(fallback.hits.every((h) => h.memory.actorId === project)).toBe(true);
    });

    it("recalls project and global memories together", async () => {
      const { project, global } = ns();
      await target.storage.store({ actorId: project, content: "This project formats with Biome" });
      await target.storage.store({ actorId: global, content: "I always format code before committing" });

      const { hits } = await retriever.recall({ actorIds: [project, global], query: "format" });
      expect(hits.map((h) => h.memory.actorId).sort()).toEqual([global, project].sort());
    });

    it("reflects updates and deletes", async () => {
      const { project } = ns();
      const memory = await target.storage.store({ actorId: project, content: "The database is Postgres" });
      await target.storage.store({ id: memory.id, actorId: project, content: "The database is SQLite" });

      const updated = await retriever.recall({ actorIds: [project], query: "database" });
      expect(updated.hits.map((h) => h.memory.content)).toEqual(["The database is SQLite"]);

      await target.storage.delete(memory.id);
      const deleted = await retriever.recall({ actorIds: [project], query: "database" });
      expect(deleted.hits).toEqual([]);
    });

    it("falls back to the most important memories when nothing matches", async () => {
      const { project } = ns();
      await target.storage.store({ actorId: project, content: "Minor note", importance: 0.2 });
      await target.storage.store({ actorId: project, content: "Never commit secrets", importance: 0.9 });

      const { hits, fallback } = await retriever.recall({ actorIds: [project], query: "kubernetes" });
      expect(fallback).toBe(true);
      expect(hits.map((h) => h.memory.content)).toEqual(["Never commit secrets", "Minor note"]);
    });
  });
}
