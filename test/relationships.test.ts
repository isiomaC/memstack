import { describe, it, expect } from "vitest";
import { RelationshipGraph } from "../src/relationships/RelationshipGraph.js";

describe("RelationshipGraph", () => {
  it("sets a relationship", async () => {
    const graph = new RelationshipGraph();
    const rel = await graph.set("npc_elena", "player", {
      affinity: 20,
      trust: 15,
    });

    expect(rel.actorA).toBe("npc_elena");
    expect(rel.actorB).toBe("player");
    expect(rel.affinity).toBe(20);
    expect(rel.trust).toBe(15);
    expect(rel.fear).toBe(0);
    expect(rel.respect).toBe(0);
    expect(rel.stage).toBe("acquaintance");
    expect(rel.interactionCount).toBe(1);
  });

  it("updates with deltas", async () => {
    const graph = new RelationshipGraph();
    await graph.set("a", "b", { affinity: 10 });
    const updated = await graph.updateDeltas("a", "b", { affinity: 5, trust: 3 });

    expect(updated.affinity).toBe(15);
    expect(updated.trust).toBe(3);
  });

  it("returns null for missing", async () => {
    const graph = new RelationshipGraph();
    const result = await graph.get("x", "y");
    expect(result).toBeNull();
  });

  it("clamps affinity to [-100, 100]", async () => {
    const graph = new RelationshipGraph();
    const tooHigh = await graph.set("a", "b", { affinity: 150 });
    expect(tooHigh.affinity).toBe(100);

    const tooLow = await graph.set("c", "d", { affinity: -200 });
    expect(tooLow.affinity).toBe(-100);
  });

  it("computes stages correctly", async () => {
    const graph = new RelationshipGraph();

    expect((await graph.set("a", "b", { affinity: 0 })).stage).toBe("stranger");
    expect((await graph.set("a", "c", { affinity: 20 })).stage).toBe("acquaintance");
    expect((await graph.set("a", "d", { affinity: 40 })).stage).toBe("friend");
    expect((await graph.set("a", "e", { affinity: 70 })).stage).toBe("close_friend");
    expect((await graph.set("a", "f", { affinity: 90 })).stage).toBe("romantic");
    expect((await graph.set("a", "g", { affinity: -40 })).stage).toBe("rival");
    expect((await graph.set("a", "h", { affinity: -80 })).stage).toBe("nemesis");
  });

  it("finds by filter", async () => {
    const graph = new RelationshipGraph();
    await graph.set("a", "b", { affinity: 50, tags: ["friend"] });
    await graph.set("a", "c", { affinity: -30, tags: ["enemy"] });

    const friends = await graph.find({ minAffinity: 0 });
    expect(friends).toHaveLength(1);
    expect(friends[0].actorB).toBe("b");

    const byTag = await graph.find({ tag: "enemy" });
    expect(byTag).toHaveLength(1);
  });
});
