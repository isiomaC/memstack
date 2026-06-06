import { describe, it, expect } from "vitest";
import { QuestManager } from "../src/quests/QuestManager.js";

describe("QuestManager", () => {
  it("creates a quest", async () => {
    const mgr = new QuestManager();
    const quest = await mgr.create({
      title: "Save the Village",
      description: "Defeat the goblins",
      giverId: "npc_elder",
      objectives: [
        { index: 0, description: "Kill 5 goblins", isOptional: false, targetCount: 5 },
        { index: 1, description: "Find the amulet", isOptional: true },
      ],
    });

    expect(quest.id).toMatch(/^quest_/);
    expect(quest.status).toBe("offered");
    expect(quest.objectives).toHaveLength(2);
    expect(quest.objectives[0].isComplete).toBe(false);
  });

  it("accepts a quest", async () => {
    const mgr = new QuestManager();
    const quest = await mgr.create({
      title: "Test Quest",
      description: "A test",
      giverId: "npc_1",
      objectives: [{ index: 0, description: "Do thing", isOptional: false }],
    });

    const accepted = await mgr.accept(quest.id, "player_1");
    expect(accepted.status).toBe("accepted");
    expect(accepted.takerId).toBe("player_1");
  });

  it("cannot accept non-offered quest", async () => {
    const mgr = new QuestManager();
    const quest = await mgr.create({
      title: "Test Quest",
      description: "A test",
      giverId: "npc_1",
      objectives: [{ index: 0, description: "Do thing", isOptional: false }],
    });

    await mgr.accept(quest.id, "player_1");
    await expect(mgr.accept(quest.id, "player_2")).rejects.toThrow("not available");
  });

  it("updates objectives and auto-completes", async () => {
    const mgr = new QuestManager();
    const quest = await mgr.create({
      title: "Simple Quest",
      description: "Just one objective",
      giverId: "npc_1",
      objectives: [{ index: 0, description: "Collect item", isOptional: false }],
    });

    await mgr.accept(quest.id, "player_1");
    const updated = await mgr.updateObjective(quest.id, 0, true);

    expect(updated.objectives[0].isComplete).toBe(true);
    expect(updated.status).toBe("completed");
  });

  it("lists by status", async () => {
    const mgr = new QuestManager();
    const q1 = await mgr.create({
      title: "Quest 1", description: "A", giverId: "npc_1",
      objectives: [{ index: 0, description: "x", isOptional: false }],
    });
    await mgr.accept(q1.id, "p1");

    const offered = await mgr.list({ status: "offered" });
    expect(offered).toHaveLength(0);

    const accepted = await mgr.list({ status: "accepted" });
    expect(accepted).toHaveLength(1);
  });
});
