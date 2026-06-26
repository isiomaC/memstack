#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFile, readFile } from "node:fs/promises";
import { MemStack } from "@memstack/core";
import type { MemStackConfig, MemoryType, PruneStrategy } from "@memstack/core";
import { loadConfig } from "./config.js";

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      actor: { type: "string" },
      content: { type: "string" },
      type: { type: "string" },
      importance: { type: "string" },
      tags: { type: "string" },
      query: { type: "string" },
      strategy: { type: "string" },
      limit: { type: "string" },
      "max-tokens": { type: "string" },
      "older-than": { type: "string" },
      "max-age": { type: "string" },
      "min-importance": { type: "string" },
      "max-count": { type: "string" },
      ids: { type: "string" },
      id: { type: "string" },
      "created-after": { type: "string" },
      "created-before": { type: "string" },
      "dry-run": { type: "boolean" },
      out: { type: "string" },
      file: { type: "string" },
    },
  });

  const command = positionals[0];
  if (!command) {
    printUsage();
    process.exit(1);
  }

  const config: MemStackConfig = await loadConfig();
  const ms = new MemStack(config);

  let result: unknown;
  switch (command) {
    case "store": {
      if (!values.actor) fail("--actor is required");
      if (!values.content) fail("--content is required");
      result = await ms.memory.store({
        actorId: String(values.actor),
        content: String(values.content),
        memoryType: values.type as MemoryType | undefined,
        importance: values.importance ? Number(values.importance) : undefined,
        tags: values.tags
          ? String(values.tags)
              .split(",")
              .map((t) => t.trim())
          : undefined,
      });
      break;
    }

    case "retrieve": {
      if (!values.actor) fail("--actor is required");
      result = await ms.memory.retrieve({
        actorId: values.actor as string | undefined,
        query: values.query as string | undefined,
        strategy: values.strategy as "recent" | "important" | "semantic" | "hybrid" | undefined,
        limit: values.limit ? Number(values.limit) : undefined,
        tags: values.tags ? String(values.tags).split(",") : undefined,
        createdAfter: values["created-after"]
          ? new Date(String(values["created-after"]))
          : undefined,
        createdBefore: values["created-before"]
          ? new Date(String(values["created-before"]))
          : undefined,
      });
      break;
    }

    case "context": {
      if (!values.actor) fail("--actor is required");
      result = await ms.memory.compileContext({
        actorId: String(values.actor),
        maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
      });
      break;
    }

    case "summarize": {
      if (!values.actor) fail("--actor is required");
      const durationMs = values["older-than"]
        ? parseDuration(String(values["older-than"]))
        : undefined;
      const olderThan = durationMs ? new Date(Date.now() - durationMs) : undefined;
      result = await ms.memory.summarize({
        actorId: values.actor as string | undefined,
        olderThan,
      });
      break;
    }

    case "prune": {
      if (!values.actor) fail("--actor is required");
      const strategy: PruneStrategy = {
        type: (values.type as PruneStrategy["type"]) ?? "byAge",
        maxAge: values["max-age"]
          ? parseDuration(String(values["max-age"]))
          : undefined,
        minImportance: values["min-importance"]
          ? Number(values["min-importance"])
          : undefined,
        maxPerActor: values["max-count"]
          ? Number(values["max-count"])
          : undefined,
      };

      if (values["dry-run"]) {
        result = await ms.memory.dryRunPrune(strategy);
      } else {
        result = await ms.memory.prune(strategy);
      }
      break;
    }

    case "purge": {
      if (!values.actor) fail("--actor is required");
      result = await ms.memory.purgeActor(String(values.actor));
      break;
    }

    case "merge": {
      if (!values.ids) fail("--ids is required");
      result = await ms.memory.merge(
        String(values.ids)
          .split(",")
          .map((s) => s.trim()),
      );
      break;
    }

    case "stats": {
      result = await ms.memory.stats(values.actor as string | undefined);
      break;
    }

    case "delete": {
      if (!values.id) fail("--id is required");
      await ms.memory.delete(String(values.id));
      result = { deleted: true };
      break;
    }

    case "health": {
      result = await ms.health();
      break;
    }

    case "export": {
      const snapshot = await ms.export(values.actor as string | undefined);
      const outPath = values.out as string | undefined;
      if (outPath) {
        await writeFile(outPath, JSON.stringify(snapshot, null, 2), "utf-8");
      }
      result = outPath ? { saved: outPath, count: snapshot.memories.length } : snapshot;
      break;
    }

    case "import": {
      if (!values.actor) fail("--actor is required");
      if (!values.file) fail("--file is required");
      const raw = await readFile(String(values.file), "utf-8");
      let snapshot = JSON.parse(raw);
      if (Array.isArray(snapshot)) {
        snapshot = { version: 1 as const, memories: snapshot, exportedAt: new Date().toISOString() };
      }
      await ms.import(snapshot);
      result = { imported: snapshot.memories?.length ?? 0 };
      break;
    }

    default:
      printUsage();
      process.exit(1);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  await ms.close();
}

function parseDuration(input: string): number {
  const match = input.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid duration: ${input}. Use format like "7d", "24h", "30m".`,
    );
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 3600 * 1000;
    case "d":
      return value * 86400 * 1000;
    default:
      return value;
  }
}

function printUsage() {
  process.stderr.write(`memstack <command> [flags]

Commands:
  store       Store a memory
  retrieve    Retrieve memories
  context     Compile LLM-ready context
  summarize   Compress old interactions
  prune       Remove stale memories
  purge       Delete all memories for an actor
  merge       Merge multiple memories
  stats       Memory diagnostics
  delete      Delete a single memory
  health      Check connectivity
  export      Export all memories
  import      Import memories from a JSON snapshot

Run memstack <command> --help for flags.
`);
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(
    `Error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
