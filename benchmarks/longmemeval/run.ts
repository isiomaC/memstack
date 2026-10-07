import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  aggregateEvidenceRecall,
  DEFAULT_K_VALUES,
  isLongMemEvalAbstention,
  retrieveQuestionAtK,
  SCORER_ID,
  SCORER_VERSION,
  scoreEvidenceRecall,
  streamLongMemEvalQuestions,
} from "./benchmark.js";

interface PackManifest {
  schemaVersion: string;
  id: string;
  version: string;
  source: { repository: string; revision: string; dataset: string; task: string };
  license: { id: string; name: string; url: string; attribution: string; useNotes: string };
  splits: Array<{ id: string; role: string; visibility: string; assets: Array<{ path: string; sizeBytes: number; sha256: string }> }>;
}

interface Options {
  datasetPath: string;
  manifestPath: string;
  limit?: number;
}

export async function runLongMemEval(options: Options) {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as PackManifest;
  if (manifest.schemaVersion !== "val-benchmark-pack/v1") throw new Error("unsupported benchmark manifest schema");
  const split = manifest.splits.find((candidate) => candidate.id === "public-evaluation");
  if (!split || split.role !== "evaluation" || split.visibility !== "public" || split.assets.length !== 1) {
    throw new Error("manifest must contain the single public-evaluation dataset asset");
  }
  const asset = split.assets[0]!;
  const info = await stat(options.datasetPath);
  if (!info.isFile() || info.size !== asset.sizeBytes) throw new Error(`dataset size mismatch: expected ${asset.sizeBytes} bytes, received ${info.size}`);
  const datasetSha256 = await hashFile(options.datasetPath);
  if (datasetSha256 !== asset.sha256) throw new Error(`dataset SHA-256 mismatch: expected ${asset.sha256}, received ${datasetSha256}`);

  const scores = new Map<number, ReturnType<typeof scoreEvidenceRecall>[]>();
  const latencies = new Map<number, number[]>();
  for (const k of DEFAULT_K_VALUES) {
    scores.set(k, []);
    latencies.set(k, []);
  }

  let scannedQuestionCount = 0;
  let abstentionCount = 0;
  for await (const question of streamLongMemEvalQuestions(options.datasetPath)) {
    if (options.limit !== undefined && scannedQuestionCount >= options.limit) break;
    scannedQuestionCount++;
    if (isLongMemEvalAbstention(question)) {
      abstentionCount++;
      continue;
    }
    const result = await retrieveQuestionAtK(question);
    for (const k of DEFAULT_K_VALUES) {
      scores.get(k)!.push(result.scores[k]!);
      latencies.get(k)!.push(result.latencyMs[k]!);
    }
  }
  if (scannedQuestionCount === 0) throw new Error("dataset contained no questions");
  if (options.limit === undefined && scannedQuestionCount !== 500) {
    throw new Error(`full LongMemEval-S run expected 500 questions, received ${scannedQuestionCount}`);
  }

  const metrics = DEFAULT_K_VALUES.map((k) => ({
    k,
    ...aggregateEvidenceRecall(scores.get(k)!),
    latencyMs: summarizeLatency(latencies.get(k)!),
  }));
  return {
    pack: { id: manifest.id, version: manifest.version, split: split.id, role: split.role, visibility: split.visibility },
    dataset: {
      repository: manifest.source.repository,
      revision: manifest.source.revision,
      name: manifest.source.dataset,
      sizeBytes: info.size,
      sha256: datasetSha256,
      license: { id: manifest.license.id, name: manifest.license.name, url: manifest.license.url, attribution: manifest.license.attribution },
      dataVisibility: "public",
    },
    scorer: { id: SCORER_ID, version: SCORER_VERSION },
    retrieval: { strategy: "MemStack HarnessMemory lexical BM25", storage: "InMemoryStorageAdapter", kValues: [...DEFAULT_K_VALUES] },
    metricDefinition: "Evidence-session recall is the number of distinct answer_session_ids retrieved in the top K divided by the number of answer_session_ids. LongMemEval abstention questions (question_id ending in _abs) and rows without evidence IDs are excluded. Macro averages per-question recall; micro pools all evidence sessions. This is retrieval-only, not end-to-end QA accuracy.",
    run: {
      scannedQuestionCount,
      evaluatedQuestionCount: scores.get(DEFAULT_K_VALUES[0])!.length,
      abstentionCount,
      partial: options.limit !== undefined,
      limit: options.limit ?? null,
      networkDuringRun: false,
      credentialsRequired: [],
    },
    metrics,
  };
}

function summarizeLatency(values: number[]) {
  if (values.length === 0) return { count: 0, median: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function parseArgs(args: string[]): Options {
  const result: Partial<Options> = {
    manifestPath: resolve(fileURLToPath(new URL("./manifest.json", import.meta.url))),
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--") continue;
    if (key === "--dataset" || key === "--manifest" || key === "--limit") {
      const value = args[++i];
      if (!value) throw new Error(`${key} requires a value`);
      if (key === "--dataset") result.datasetPath = resolve(value);
      if (key === "--manifest") result.manifestPath = resolve(value);
      if (key === "--limit") result.limit = Number(value);
    } else if (key === "--help" || key === "-h") {
      console.log("Usage: pnpm benchmark:longmemeval -- --dataset <cached-json> [--manifest <manifest.json>] [--limit <questions>]");
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${key}`);
    }
  }
  if (!result.datasetPath || !result.manifestPath) throw new Error("--dataset <cached-json> is required");
  return result as Options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const report = await runLongMemEval(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
