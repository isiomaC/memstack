import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryStorageAdapter } from "../src/adapters/storage/memory.js";
import { HarnessMemory } from "../src/harness/HarnessMemory.js";
import type { LLMProvider } from "../src/interfaces.js";

const source = { harness: "claude-code", project: "abc", sessionId: "s1", cwd: "/repo" };

function fakeLlm(reply: string | (() => Promise<string>)): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    complete: vi.fn(async () => ({
      text: typeof reply === "string" ? reply : await reply(),
      tokens: { prompt: 1, completion: 1, total: 2 },
    })),
  };
}

describe("HarnessMemory", () => {
  let storage: InMemoryStorageAdapter;

  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  describe("remember", () => {
    it("stores provenance, kind, and LLM tags merged with caller tags", async () => {
      const llm = fakeLlm('```json\n["Framework", "backend", "hono"]\n```');
      const harness = new HarnessMemory({ storage, llm });

      const memory = await harness.remember({
        namespace: "project:abc",
        content: "  This project uses Hono  ",
        kind: "decision",
        tags: ["hono", "api"],
        source,
      });

      expect(memory).toMatchObject({
        actorId: "project:abc",
        content: "This project uses Hono",
        memoryType: "decision",
        tags: ["hono", "api", "framework", "backend"],
        metadata: { source },
      });
    });

    it("bridges vocabulary so a category question finds the memory", async () => {
      const harness = new HarnessMemory({ storage, llm: fakeLlm('["framework", "backend"]') });
      await harness.remember({ namespace: "project:abc", content: "We picked Hono", source });

      const { hits } = await harness.recall({ namespaces: ["project:abc"], query: "Which framework?" });
      expect(hits.map((h) => h.memory.content)).toEqual(["We picked Hono"]);
    });

    it("stores the memory untagged when tagging fails", async () => {
      const onError = vi.fn();
      const llm = fakeLlm(() => Promise.reject(new Error("provider down")));
      const harness = new HarnessMemory({ storage, llm, onError });

      const memory = await harness.remember({ namespace: "project:abc", content: "Uses Hono", source });

      expect(memory.tags).toEqual([]);
      expect(await storage.get(memory.id)).not.toBeNull();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "provider down" }), "harness-tagging");
    });

    it("stops waiting for a slow provider", async () => {
      const llm = fakeLlm(() => new Promise<string>(() => undefined));
      const onError = vi.fn();
      const harness = new HarnessMemory({ storage, llm, tagTimeoutMs: 20, onError });

      const memory = await harness.remember({ namespace: "project:abc", content: "Uses Hono", source });

      expect(memory.tags).toEqual([]);
      expect(onError.mock.calls[0][0].message).toMatch(/timed out/);
    });

    it("reports an empty reply as a tagging failure", async () => {
      const onError = vi.fn();
      const harness = new HarnessMemory({ storage, llm: fakeLlm("  "), onError });
      const memory = await harness.remember({ namespace: "project:abc", content: "Uses Hono", source });
      expect(memory.tags).toEqual([]);
      expect(onError.mock.calls[0][0].message).toMatch(/empty reply/);
    });

    it("drops malformed tags from the LLM", async () => {
      const harness = new HarnessMemory({ storage, llm: fakeLlm('["ok", "two words", "", "c++"]') });
      const memory = await harness.remember({ namespace: "project:abc", content: "Uses Hono", source });
      expect(memory.tags).toEqual(["ok"]);
    });

    it("skips the LLM when autoTags is false", async () => {
      const llm = fakeLlm("[]");
      const harness = new HarnessMemory({ storage, llm, autoTags: false });
      await harness.remember({ namespace: "project:abc", content: "Uses Hono", source });
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it("defaults kind to observation and importance to 0.5", async () => {
      const harness = new HarnessMemory({ storage, llm: fakeLlm("[]") });
      const memory = await harness.remember({ namespace: "project:abc", content: "Note", source });
      expect(memory).toMatchObject({ memoryType: "observation", importance: 0.5 });
    });

    it.each([
      [{ content: "   " }, /empty/],
      [{ content: "x".repeat(9) }, /longer than 8/],
      [{ namespace: "" }, /Namespace/],
      [{ importance: 1.5 }, /Importance/],
    ])("rejects invalid input %o", async (override, message) => {
      const harness = new HarnessMemory({ storage, llm: fakeLlm("[]"), maxContentChars: 8 });
      await expect(
        harness.remember({ namespace: "project:abc", content: "ok", source, ...override })
      ).rejects.toThrow(message);
    });
  });

  describe("namespace isolation", () => {
    let harness: HarnessMemory;
    let otherId: string;

    beforeEach(async () => {
      harness = new HarnessMemory({ storage, llm: fakeLlm("[]") });
      otherId = (await harness.remember({ namespace: "project:other", content: "Secret plan", source })).id;
    });

    it("hides memories from other namespaces in get", async () => {
      expect(await harness.get(otherId, ["project:abc", "global"])).toBeNull();
      expect((await harness.get(otherId, ["project:other"]))?.content).toBe("Secret plan");
    });

    it("refuses to forget memories from other namespaces", async () => {
      await expect(harness.forget(otherId, ["project:abc"])).rejects.toThrow(/not found/);
      expect(await storage.get(otherId)).not.toBeNull();

      await harness.forget(otherId, ["project:other"]);
      expect(await storage.get(otherId)).toBeNull();
    });

    it("counts per namespace", async () => {
      await harness.remember({ namespace: "project:abc", content: "Mine", source });
      expect(await harness.stats(["project:abc", "global"])).toEqual({ "project:abc": 1, global: 0 });
    });
  });

  describe("moving namespaces", () => {
    it("moves memories with their content, kind, tags, provenance, and creation time", async () => {
      const harness = new HarnessMemory({ storage, llm: fakeLlm('["framework"]') });
      const original = await harness.remember({ namespace: "project:old", content: "Uses Hono", kind: "decision", importance: 0.8, source });
      await storage.store({ actorId: "project:old", content: "Old note", createdAt: new Date("2026-01-01T00:00:00Z") });

      expect(await harness.moveNamespace("project:old", "project:new")).toBe(2);

      expect(await storage.count({ actorId: "project:old" })).toBe(0);
      const moved = await storage.retrieve({ actorId: "project:new", limit: 10, touch: false });
      expect(moved.map((m) => m.content).sort()).toEqual(["Old note", "Uses Hono"]);
      expect(moved.find((m) => m.content === "Uses Hono")).toMatchObject({
        memoryType: "decision",
        importance: 0.8,
        tags: ["framework"],
        metadata: { source },
        createdAt: original.createdAt,
      });
      expect(moved.find((m) => m.content === "Old note")!.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    });

    it("leaves one copy when two processes move at the same time", async () => {
      for (let i = 0; i < 20; i++) await storage.store({ actorId: "project:old", content: `note ${i}` });
      const a = new HarnessMemory({ storage, llm: fakeLlm("[]") });
      const b = new HarnessMemory({ storage, llm: fakeLlm("[]") });

      await Promise.all([a.moveNamespace("project:old", "project:new"), b.moveNamespace("project:old", "project:new")]);

      expect(await storage.count({ actorId: "project:old" })).toBe(0);
      expect(await storage.count({ actorId: "project:new" })).toBe(20);
    });

    it("adopts previous project IDs and skips empty ones", async () => {
      const harness = new HarnessMemory({ storage, llm: fakeLlm("[]") });
      await storage.store({ actorId: "project:before-first-commit", content: "Early decision" });
      const count = vi.spyOn(storage, "count");

      expect(await harness.adoptProjects(["before-first-commit", "empty", "current"], "current")).toBe(1);
      expect(count).toHaveBeenCalledTimes(2);
      expect((await harness.recall({ namespaces: ["project:current"], query: "decision" })).hits).toHaveLength(1);

      expect(await harness.adoptProjects(["before-first-commit"], "current")).toBe(0);
    });
  });

  it("initializes storage once", async () => {
    const init = vi.spyOn(storage, "initialize");
    const harness = new HarnessMemory({ storage, llm: fakeLlm("[]") });
    await Promise.all([
      harness.remember({ namespace: "project:abc", content: "One", source }),
      harness.recall({ namespaces: ["project:abc"], query: "one" }),
    ]);
    expect(init).toHaveBeenCalledTimes(1);
  });
});

describe("HarnessMemory secret policy", () => {
  const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const base = { namespace: "project:abc", source };

  it("rejects a memory with a secret by default, names the kind, and never calls the LLM", async () => {
    const storage = new InMemoryStorageAdapter();
    const llm = fakeLlm('["deploy"]');
    const harness = new HarnessMemory({ storage, llm });

    const error = await harness.remember({ ...base, content: `Deploy with ${secret}` }).catch((e) => e);

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("github-token");
    expect(error.message).not.toContain(secret);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(await storage.count({ actorId: "project:abc" })).toBe(0);
  });

  it("rejects a secret smuggled in through a tag", async () => {
    const harness = new HarnessMemory({ storage: new InMemoryStorageAdapter(), llm: fakeLlm("[]") });
    await expect(harness.remember({ ...base, content: "Deploys use a token", tags: [secret] })).rejects.toThrow(/secret/);
  });

  it("redacts before the LLM and storage see the text when the policy is redact", async () => {
    const storage = new InMemoryStorageAdapter();
    const llm = fakeLlm('["deploy"]');
    const harness = new HarnessMemory({ storage, llm, secretPolicy: "redact" });

    const memory = await harness.remember({ ...base, content: `Deploy with ${secret}` });

    expect(memory.content).toBe("Deploy with [REDACTED:github-token]");
    expect(memory.metadata).toMatchObject({ redacted: ["github-token"] });
    expect(llm.complete.mock.calls[0][0].user).not.toContain(secret);
    expect(JSON.stringify(await storage.retrieve({ actorId: "project:abc", limit: 10 }))).not.toContain(secret);
  });

  it("stores the text unchanged when the policy is off", async () => {
    const harness = new HarnessMemory({ storage: new InMemoryStorageAdapter(), llm: fakeLlm("[]"), secretPolicy: "off" });
    const memory = await harness.remember({ ...base, content: `Deploy with ${secret}` });
    expect(memory.content).toContain(secret);
  });
});
