import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../benchmarks/longmemeval/manifest.json", import.meta.url), "utf8"));

describe("LongMemEval Val pack manifest", () => {
  it("pins the public cleaned S artifact by immutable revision, exact size, and SHA-256", () => {
    expect(manifest.schemaVersion).toBe("val-benchmark-pack/v1");
    expect(manifest.source.revision).toBe("98d7416c24c778c2fee6e6f3006e7a073259d48f");
    expect(manifest.splits).toHaveLength(1);
    expect(manifest.splits[0]).toMatchObject({ id: "public-evaluation", role: "evaluation", visibility: "public" });
    expect(manifest.splits[0].assets).toEqual([{
      path: "longmemeval_s_cleaned.json",
      url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json",
      sizeBytes: 277383467,
      sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
      mediaType: "application/json",
    }]);
    expect(manifest.splits[0].assets[0].url).not.toMatch(/\/resolve\/main\//);
  });

  it("does not claim a hidden set or QA leaderboard equivalence", () => {
    expect(manifest.splits[0].visibility).toBe("public");
    expect(manifest.source.contaminationNotes.join(" ")).toMatch(/not be described as hidden/);
    expect(manifest.source.contaminationNotes.join(" ")).toMatch(/not directly comparable/);
    expect(manifest.requirements.credentials).toEqual([]);
  });
});
