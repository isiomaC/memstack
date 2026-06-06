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
    expect(ms.relationships).toBeDefined();
    expect(ms.quests).toBeDefined();
  });

  it("throws without LLM", () => {
    expect(() => new MemStack({ llm: undefined as unknown as typeof mockLLM })).toThrow();
  });

  it("process() stores memory and returns result", async () => {
    const ms = new MemStack({ llm: mockLLM });
    const result = await ms.process({
      actorId: "npc_elena",
      content: "The player greeted me warmly.",
      importance: 0.8,
      emotionalValence: 0.6,
    });

    expect(result.memory.id).toMatch(/^mem_/);
    expect(result.memory.actorId).toBe("npc_elena");
    expect(result.memory.content).toBe("The player greeted me warmly.");
    expect(result.memory.importance).toBe(0.8);
    expect(result.memory.emotionalValence).toBe(0.6);
  });

  it("process() updates relationship when targetId provided", async () => {
    const ms = new MemStack({ llm: mockLLM });
    const result = await ms.process({
      actorId: "npc_elena",
      content: "Saved from danger",
      targetId: "player_1",
      relationshipDelta: { affinity: 10, trust: 5 },
    });

    expect(result.relationshipUpdate).toBeDefined();
    expect(result.relationshipUpdate!.current.affinity).toBe(10);
    expect(result.relationshipUpdate!.current.trust).toBe(5);
  });

  it("compileContext assembles prompt from memories", async () => {
    const ms = new MemStack({ llm: mockLLM });
    // Store 15+ memories so both Recent and Important sections have content
    for (let i = 0; i < 15; i++) {
      await ms.process({
        actorId: "npc_1",
        content: `Memory ${i}`,
        importance: i % 3 === 0 ? 0.9 : 0.3,
      });
    }

    const ctx = await ms.memory.compileContext({ actorId: "npc_1" });

    expect(ctx.systemPrompt).toContain("Recent Interactions");
    expect(ctx.recentMemories.length).toBeGreaterThan(0);
    expect(ctx.importantMemories.length).toBeGreaterThan(0);
    expect(ctx.tokenEstimate).toBeGreaterThan(0);
  });

  it("export() and import() round-trips", async () => {
    const ms = new MemStack({ llm: mockLLM });
    await ms.process({ actorId: "a", content: "test memory" });
    await ms.relationships.set("a", "b", { affinity: 50 });

    const snapshot = await ms.export();
    expect(snapshot.version).toBe(1);
    expect(snapshot.memories).toHaveLength(1);
    expect(snapshot.relationships).toHaveLength(1);

    const ms2 = new MemStack({ llm: mockLLM });
    await ms2.import(snapshot);

    const restored = await ms2.memory.retrieve({ actorId: "a" });
    expect(restored).toHaveLength(1);
    expect(restored[0].content).toBe("test memory");

    const restoredRel = await ms2.relationships.get("a", "b");
    expect(restoredRel?.affinity).toBe(50);
  });

  it("dryRunPrune shows what would be removed without deleting", async () => {
    const ms = new MemStack({ llm: mockLLM });
    await ms.process({ actorId: "a", content: "old unimportant", importance: 0.1 });
    await ms.process({ actorId: "a", content: "important", importance: 0.9 });

    const dry = await ms.memory.dryRunPrune({ type: "byImportance", minImportance: 0.5 });
    expect(dry.count).toBe(1);

    const stillThere = await ms.memory.count();
    expect(stillThere).toBe(2); // dryRun doesn't delete
  });
});
