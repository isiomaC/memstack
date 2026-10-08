import { createReadStream } from "node:fs";
import { InMemoryStorageAdapter } from "../../src/adapters/storage/memory.js";
import { HarnessMemory } from "../../src/harness/HarnessMemory.js";
import { projectNamespace } from "../../src/harness/namespaces.js";

export interface LongMemEvalTurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

export interface LongMemEvalQuestion {
  question_id: string;
  question: string;
  haystack_session_ids: string[];
  haystack_sessions: LongMemEvalTurn[][];
  answer_session_ids: string[];
}

export interface EvidenceRecallScore {
  retrievedEvidenceCount: number;
  expectedEvidenceCount: number;
  recall: number;
  hit: boolean;
}

export const DEFAULT_K_VALUES = [1, 3, 5, 10] as const;
export const SCORER_ID = "memstack.longmemeval-evidence-session-recall";
export const SCORER_VERSION = "1.0.0";

export function validateLongMemEvalQuestion(value: unknown): asserts value is LongMemEvalQuestion {
  if (!isRecord(value)) throw new Error("LongMemEval row must be an object");
  if (typeof value.question_id !== "string" || value.question_id.length === 0) throw new Error("question_id must be a non-empty string");
  if (typeof value.question !== "string" || value.question.length === 0) throw new Error(`question must be a non-empty string (${value.question_id})`);
  if (!stringArray(value.haystack_session_ids)) throw new Error(`haystack_session_ids must be an array of strings (${value.question_id})`);
  if (!Array.isArray(value.haystack_sessions)) throw new Error(`haystack_sessions must be an array (${value.question_id})`);
  const sessionIds = value.haystack_session_ids;
  const sessions = value.haystack_sessions;
  if (sessionIds.length !== sessions.length) {
    throw new Error(`haystack_session_ids and haystack_sessions must have equal lengths (${value.question_id})`);
  }
  const sessionById = new Map<string, string>();
  for (const [sessionIndex, session] of sessions.entries()) {
    if (!Array.isArray(session)) throw new Error(`haystack session ${sessionIndex} must be an array (${value.question_id})`);
    if (session.length === 0) throw new Error(`haystack session ${sessionIndex} must contain at least one turn (${value.question_id})`);
    for (const [turnIndex, turn] of session.entries()) {
      if (!isRecord(turn) || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.content !== "string") {
        throw new Error(`invalid turn ${turnIndex} in session ${sessionIndex} (${value.question_id})`);
      }
    }
    const sessionId = sessionIds[sessionIndex]!;
    const serialized = JSON.stringify(session);
    const previous = sessionById.get(sessionId);
    if (previous !== undefined && previous !== serialized) {
      throw new Error(`duplicate haystack session ID has conflicting content (${value.question_id}: ${sessionId})`);
    }
    sessionById.set(sessionId, serialized);
  }
  if (!stringArray(value.answer_session_ids)) throw new Error(`answer_session_ids must be an array of strings (${value.question_id})`);
  const answerSessionIds = value.answer_session_ids;
  if (answerSessionIds.some((id) => !sessionIds.includes(id))) {
    throw new Error(`answer_session_ids must refer to haystack_session_ids (${value.question_id})`);
  }
}

export function formatSession(turns: LongMemEvalTurn[]): string {
  return turns.map(({ role, content }) => `${role}: ${content}`).join("\n");
}

export function scoreEvidenceRecall(expectedSessionIds: string[], retrievedSessionIds: string[]): EvidenceRecallScore {
  const expected = new Set(expectedSessionIds);
  if (expected.size === 0) throw new Error("cannot score evidence recall: no answer_session_ids (abstention row)");
  const retrieved = new Set(retrievedSessionIds);
  let retrievedEvidenceCount = 0;
  for (const id of expected) if (retrieved.has(id)) retrievedEvidenceCount++;
  return {
    retrievedEvidenceCount,
    expectedEvidenceCount: expected.size,
    recall: retrievedEvidenceCount / expected.size,
    hit: retrievedEvidenceCount > 0,
  };
}

export function isLongMemEvalAbstention(question: Pick<LongMemEvalQuestion, "question_id" | "answer_session_ids">): boolean {
  return question.question_id.endsWith("_abs") || question.answer_session_ids.length === 0;
}

export function aggregateEvidenceRecall(scores: EvidenceRecallScore[]) {
  if (scores.length === 0) throw new Error("cannot aggregate evidence recall without scored questions");
  const retrievedEvidenceCount = scores.reduce((total, score) => total + score.retrievedEvidenceCount, 0);
  const expectedEvidenceCount = scores.reduce((total, score) => total + score.expectedEvidenceCount, 0);
  return {
    questionCount: scores.length,
    expectedEvidenceCount,
    retrievedEvidenceCount,
    macroRecall: scores.reduce((total, score) => total + score.recall, 0) / scores.length,
    microRecall: retrievedEvidenceCount / expectedEvidenceCount,
    questionHitRate: scores.filter((score) => score.hit).length / scores.length,
  };
}

export async function retrieveQuestionAtK(
  question: LongMemEvalQuestion,
  kValues: readonly number[] = DEFAULT_K_VALUES,
): Promise<{ scores: Record<number, EvidenceRecallScore>; latencyMs: Record<number, number> }> {
  validateLongMemEvalQuestion(question);
  if (isLongMemEvalAbstention(question)) throw new Error(`cannot retrieve-score abstention row ${question.question_id}`);
  if (kValues.length === 0 || kValues.some((k) => !Number.isInteger(k) || k < 1 || k > 25)) {
    throw new Error("K values must be integers between 1 and 25");
  }

  const storage = new InMemoryStorageAdapter();
  const memory = new HarnessMemory({
    storage,
    llm: { complete: async () => ({ text: "[]", tokens: { prompt: 0, completion: 0, total: 0 } }) },
    autoTags: false,
    maxContentChars: 1_000_000,
    // Public benchmark text is indexed only in this in-memory adapter; scanning
    // can reject literal credential-shaped examples and nothing is sent out.
    secretPolicy: "off",
  });
  const namespace = projectNamespace(`longmemeval:${question.question_id}`);
  try {
    const storedSessionIds = new Set<string>();
    for (let index = 0; index < question.haystack_sessions.length; index++) {
      const sessionId = question.haystack_session_ids[index]!;
      if (storedSessionIds.has(sessionId)) continue;
      storedSessionIds.add(sessionId);
      await memory.remember({
        namespace,
        content: formatSession(question.haystack_sessions[index]!),
        kind: "interaction",
        importance: 0.5,
        tags: [],
        source: {
          harness: "memstack-longmemeval-benchmark",
          project: question.question_id,
          sessionId,
        },
      });
    }

    const scores: Record<number, EvidenceRecallScore> = {};
    const latencyMs: Record<number, number> = {};
    for (const k of kValues) {
      const started = performance.now();
      const result = await memory.recall({ namespaces: [namespace], query: question.question, limit: k, maxChars: Number.MAX_SAFE_INTEGER });
      latencyMs[k] = performance.now() - started;
      const retrieved = result.hits.flatMap(({ memory: hit }) => {
        const source = hit.metadata?.source;
        return isRecord(source) && typeof source.sessionId === "string" ? [source.sessionId] : [];
      });
      scores[k] = scoreEvidenceRecall(question.answer_session_ids, retrieved);
    }
    return { scores, latencyMs };
  } finally {
    await storage.close();
  }
}

/** Stream a top-level JSON array of question objects with bounded parsing memory. */
export async function* streamLongMemEvalQuestions(path: string): AsyncGenerator<LongMemEvalQuestion> {
  let openedArray = false;
  let finishedArray = false;
  let needsComma = false;
  let afterComma = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let parts: Buffer[] = [];
  let row = 0;

  for await (const chunkValue of createReadStream(path)) {
    const chunk = Buffer.from(chunkValue);
    let itemStart = depth > 0 ? 0 : -1;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index]!;
      if (!openedArray) {
        if (isWhitespace(byte)) continue;
        if (byte !== 0x5b) throw new Error("LongMemEval dataset must be a top-level JSON array");
        openedArray = true;
        continue;
      }
      if (finishedArray) {
        if (!isWhitespace(byte)) throw new Error("unexpected content after LongMemEval JSON array");
        continue;
      }
      if (depth === 0) {
        if (isWhitespace(byte)) continue;
        if (needsComma) {
          if (byte === 0x2c) {
            needsComma = false;
            afterComma = true;
            continue;
          }
          if (byte === 0x5d) {
            finishedArray = true;
            continue;
          }
          throw new Error("expected comma or closing bracket in LongMemEval dataset");
        }
        if (byte === 0x5d && !afterComma) {
          finishedArray = true;
          continue;
        }
        if (byte !== 0x7b) throw new Error("LongMemEval dataset entries must be JSON objects");
        depth = 1;
        inString = false;
        escaped = false;
        parts = [];
        itemStart = index;
        afterComma = false;
        continue;
      }

      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
      } else if (byte === 0x22) {
        inString = true;
      } else if (byte === 0x7b) {
        depth++;
      } else if (byte === 0x7d) {
        depth--;
        if (depth === 0) {
          parts.push(chunk.subarray(itemStart < 0 ? 0 : itemStart, index + 1));
          itemStart = -1;
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
          } catch {
            throw new Error(`invalid JSON in LongMemEval row ${row + 1}`);
          }
          try {
            validateLongMemEvalQuestion(parsed);
          } catch (error) {
            throw new Error(`invalid LongMemEval row ${row + 1}: ${error instanceof Error ? error.message : String(error)}`);
          }
          row++;
          needsComma = true;
          parts = [];
          yield parsed;
        }
      }

      if (itemStart < 0 && depth > 0) itemStart = index + 1;
    }
    if (depth > 0 && itemStart >= 0) parts.push(chunk.subarray(itemStart));
  }

  if (!openedArray || !finishedArray || depth !== 0 || afterComma) throw new Error("incomplete LongMemEval JSON array");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}
