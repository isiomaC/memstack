import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateEvidenceRecall,
  formatSession,
  isLongMemEvalAbstention,
  retrieveQuestionAtK,
  scoreEvidenceRecall,
  streamLongMemEvalQuestions,
  validateLongMemEvalQuestion,
} from "../benchmarks/longmemeval/benchmark.js";

describe("LongMemEval retrieval scorer", () => {
  it("scores evidence-session recall at K without treating irrelevant hits as evidence", () => {
    expect(scoreEvidenceRecall(["s1", "s2"], ["noise", "s2", "other"])).toEqual({
      retrievedEvidenceCount: 1,
      expectedEvidenceCount: 2,
      recall: 0.5,
      hit: true,
    });
  });

  it("rejects abstention rows from the evidence recall denominator", () => {
    expect(() => scoreEvidenceRecall([], ["s1"])).toThrow(/no answer_session_ids/);
    expect(isLongMemEvalAbstention({ question_id: "q_abs", answer_session_ids: ["placeholder"] })).toBe(true);
    expect(isLongMemEvalAbstention({ question_id: "q1", answer_session_ids: [] })).toBe(true);
    expect(isLongMemEvalAbstention({ question_id: "q1", answer_session_ids: ["s1"] })).toBe(false);
  });

  it("reports macro and micro recall separately", () => {
    const metrics = aggregateEvidenceRecall([
      scoreEvidenceRecall(["a"], ["a"]),
      scoreEvidenceRecall(["b", "c", "d"], ["b"]),
    ]);
    expect(metrics.questionCount).toBe(2);
    expect(metrics.expectedEvidenceCount).toBe(4);
    expect(metrics.retrievedEvidenceCount).toBe(2);
    expect(metrics.macroRecall).toBeCloseTo(2 / 3);
    expect(metrics.microRecall).toBe(0.5);
  });

  it("validates session IDs against the parallel haystack arrays", () => {
    expect(() => validateLongMemEvalQuestion({
      question_id: "q1",
      question: "Which framework?",
      haystack_session_ids: ["s1"],
      haystack_sessions: [[{ role: "user", content: "We use Hono." }], []],
      answer_session_ids: ["s1"],
    })).toThrow(/haystack_session_ids/);
  });

  it("allows identical duplicate sessions but rejects conflicting duplicate IDs", () => {
    const duplicate = {
      question_id: "q-duplicates",
      question: "What happened?",
      haystack_session_ids: ["s1", "s1"],
      haystack_sessions: [
        [{ role: "user", content: "Same session" }],
        [{ role: "user", content: "Same session" }],
      ],
      answer_session_ids: ["s1"],
    };
    expect(() => validateLongMemEvalQuestion(duplicate)).not.toThrow();
    duplicate.haystack_sessions[1]![0]!.content = "Different session content";
    expect(() => validateLongMemEvalQuestion(duplicate)).toThrow(/conflicting content/);
  });

  it("streams records across chunk boundaries and respects JSON strings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memstack-longmemeval-"));
    const path = join(directory, "dataset.json");
    const row = {
      question_id: "q-1",
      question: `Which framework? ${"large ".repeat(20_000)} 🧠`,
      haystack_session_ids: ["s-1"],
      haystack_sessions: [[{ role: "user", content: "Use braces { and quotes \" safely." }]],
      answer_session_ids: ["s-1"],
    };
    try {
      await writeFile(path, JSON.stringify([row]));
      const rows = [];
      for await (const item of streamLongMemEvalQuestions(path)) rows.push(item);
      expect(rows).toEqual([row]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON array boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memstack-longmemeval-"));
    const path = join(directory, "dataset.json");
    try {
      await writeFile(path, "[{\"invalid\":true},]");
      await expect(async () => {
        for await (const _row of streamLongMemEvalQuestions(path)) { /* consume */ }
      }).rejects.toThrow(/invalid LongMemEval row|incomplete LongMemEval/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses MemStack's local harness API and carries session provenance into retrieval hits", async () => {
    const result = await retrieveQuestionAtK({
      question_id: "q-1",
      question: "Which web framework is used?",
      haystack_session_ids: ["noise", "evidence"],
      haystack_sessions: [
        [{ role: "user", content: "We decided to keep a changelog." }],
        [{ role: "assistant", content: "This project uses Hono as its web framework." }],
      ],
      answer_session_ids: ["evidence"],
    }, [1]);
    expect(result.scores[1]).toEqual({ retrievedEvidenceCount: 1, expectedEvidenceCount: 1, recall: 1, hit: true });
    expect(Number.isFinite(result.latencyMs[1])).toBe(true);
  });

  it("retains a benchmark session longer than the default harness write limit", async () => {
    const longContent = `The answer is Hono. ${"context ".repeat(1_200)}`;
    const result = await retrieveQuestionAtK({
      question_id: "q-long",
      question: "Which framework?",
      haystack_session_ids: ["long-session"],
      haystack_sessions: [[{ role: "user", content: longContent }]],
      answer_session_ids: ["long-session"],
    }, [1]);
    expect(result.scores[1]?.recall).toBe(1);
  });
});
