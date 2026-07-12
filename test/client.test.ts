import { describe, it, expect } from "vitest";
import { MemStack } from "../src/client.js";

const mockLLM = {
  async complete(request: { system: string; user: string }) {
    return {
      text: "Summarized: " + request.user.substring(0, 50),
      tokens: { prompt: 10, completion: 5, total: 15 },
    };
  },
};

describe("MemStack", () => {
  it("creates instance with required config", () => {
    const ms = new MemStack({ llm: mockLLM });
    expect(ms).toBeDefined();
    expect(ms.memory).toBeDefined();
  });

  it("throws without LLM", () => {
    expect(() => new MemStack({ llm: undefined as unknown as typeof mockLLM })).toThrow();
  });

  it("process() stores memory and returns result", async () => {
    const ms = new MemStack({ llm: mockLLM });
    const result = await ms.process({
      actorId: "agent-7",
      content: "User reported login failure.",
      importance: 0.8,
      emotionalValence: -0.3,
      tags: ["bug", "login"],
    });

    expect(result.memory.id).toMatch(/^mem_/);
    expect(result.memory.actorId).toBe("agent-7");
    expect(result.memory.content).toBe("User reported login failure.");
    expect(result.memory.importance).toBe(0.8);
    expect(result.memory.emotionalValence).toBe(-0.3);
    expect(result.memory.tags).toEqual(["bug", "login"]);
  });
  it("compileContext assembles prompt from memories", async () => {
    const ms = new MemStack({ llm: mockLLM });
    for (let i = 0; i < 15; i++) {
      await ms.process({
        actorId: "agent-1",
        content: `Memory ${i}`,
        importance: i % 3 === 0 ? 0.9 : 0.3,
      });
    }

    const ctx = await ms.memory.compileContext({ actorId: "agent-1", maxTokens: 5000 });
    expect(ctx.systemPrompt.length).toBeGreaterThan(0);
    expect(ctx.recentMemories.length).toBeGreaterThan(0);
    expect(ctx.importantMemories.length).toBeGreaterThan(0);
    expect(ctx.tokenEstimate).toBeLessThan(5000);
  });

  it("export() and import() round-trips", async () => {
    const ms = new MemStack({ llm: mockLLM });
    await ms.process({ actorId: "a", content: "test memory" });
    await ms.memory.store({ actorId: "a", content: "another memory", importance: 0.9 });

    const snapshot = await ms.export();
    expect(snapshot.version).toBe(1);
    expect(snapshot.memories).toHaveLength(2);

    const ms2 = new MemStack({ llm: mockLLM });
    await ms2.import(snapshot);

    const restored = await ms2.memory.retrieve({ actorId: "a" });
    expect(restored).toHaveLength(2);
    expect(restored.map((m) => m.content)).toContain("test memory");
    expect(restored.map((m) => m.content)).toContain("another memory");
  });

  it("import() preserves createdAt through a JSON round-trip", async () => {
    const ms = new MemStack({ llm: mockLLM });
    const original = new Date("2026-01-15T12:00:00.000Z");
    await ms.memory.store({ actorId: "a", content: "dated memory", createdAt: original });

    // Simulate the README backup workflow: export -> JSON string -> parse -> import.
    // JSON.parse turns Date fields back into strings, which import() must coerce.
    const snapshot = JSON.parse(JSON.stringify(await ms.export()));
    expect(typeof snapshot.memories[0].createdAt).toBe("string");

    const ms2 = new MemStack({ llm: mockLLM });
    await ms2.import(snapshot);

    const restored = await ms2.memory.retrieve({ actorId: "a" });
    expect(restored).toHaveLength(1);
    expect(restored[0].createdAt).toBeInstanceOf(Date);
    expect(restored[0].createdAt.getTime()).toBe(original.getTime());
  });

  it("dryRunPrune shows what would be removed without deleting", async () => {
    const ms = new MemStack({ llm: mockLLM });
    await ms.process({ actorId: "a", content: "old unimportant", importance: 0.1 });
    await ms.process({ actorId: "a", content: "important", importance: 0.9 });

    const dry = await ms.memory.dryRunPrune({ type: "byImportance", minImportance: 0.5 });
    expect(dry.count).toBe(1);

    const stillThere = await ms.memory.count();
    expect(stillThere).toBe(2);
  });

  it("retrieve filters by tag and strategy", async () => {
    const ms = new MemStack({ llm: mockLLM });
    await ms.process({ actorId: "a", content: "bug report", tags: ["bug"] });
    await ms.process({ actorId: "a", content: "feature request", tags: ["feature"] });

    const bugResults = await ms.memory.retrieve({ actorId: "a", tags: ["bug"] });
    expect(bugResults).toHaveLength(1);
    expect(bugResults[0].content).toBe("bug report");
  });
});
