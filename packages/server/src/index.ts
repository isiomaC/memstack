import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { MemStack } from "@memstack/core";
import type { MemoryType, MemStackSnapshot } from "@memstack/core";
import type { z } from "zod";
import { loadConfig } from "./config.js";
import {
  StoreMemorySchema,
  BatchStoreSchema,
  RetrieveSchema,
  ContextSchema,
  ProcessSchema,
  SummarizeSchema,
  PruneStrategySchema,
  MergeSchema,
  PurgeSchema,
  DeleteManySchema,
  ImportSchema,
} from "./schemas.js";
import { buildOpenApiDocument } from "./openapi.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

const app = new Hono();

let _ms: MemStack | null = null;
async function getMs(): Promise<MemStack> {
  if (!_ms) {
    _ms = new MemStack(await loadConfig());
  }
  return _ms;
}

type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: Response };

async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<ParsedBody<z.infer<S>>> {
  const raw = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, response: c.json({ error: "Validation failed", issues: result.error.issues }, 400) };
  }
  return { ok: true, data: result.data };
}

app.use("*", async (c, next) => {
  const apiKey = process.env.MEMSTACK_API_KEY;
  if (apiKey) {
    const auth = c.req.header("Authorization");
    if (!auth || auth !== `Bearer ${apiKey}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  await next();
});

const requestCounts = new Map<string, { count: number; reset: number }>();

app.use("*", async (c, next) => {
  const rateLimit = parseInt(process.env.MEMSTACK_RATE_LIMIT ?? "0", 10);
  if (rateLimit <= 0) return next();

  const key = c.req.header("x-forwarded-for") ?? "anonymous";
  const now = Date.now();
  const entry = requestCounts.get(key) ?? { count: 0, reset: now + 60000 };

  if (now > entry.reset) {
    entry.count = 1;
    entry.reset = now + 60000;
  } else {
    entry.count++;
  }

  requestCounts.set(key, entry);

  if (requestCounts.size > 10000) {
    for (const [k, v] of requestCounts) {
      if (now > v.reset) requestCounts.delete(k);
    }
  }

  if (entry.count > rateLimit) {
    return c.json({ error: "Too many requests" }, 429);
  }

  await next();
});

app.post("/v1/memories", async (c) => {
  const parsed = await parseBody(c, StoreMemorySchema);
  if (!parsed.ok) return parsed.response;
  try {
    const memory = await (await getMs()).memory.store(parsed.data);
    return c.json(memory, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/batch", async (c) => {
  const parsed = await parseBody(c, BatchStoreSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await (await getMs()).memory.storeBatch(parsed.data.memories);
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/retrieve", async (c) => {
  const parsed = await parseBody(c, RetrieveSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const results = await (await getMs()).memory.retrieve(parsed.data);
    return c.json(results);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/context", async (c) => {
  const parsed = await parseBody(c, ContextSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const ctx = await (await getMs()).memory.compileContext(parsed.data);
    return c.json({
      context: ctx.systemPrompt,
      tokenCount: ctx.tokenEstimate,
      memoryCount: ctx.recentMemories.length + ctx.importantMemories.length,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.get("/v1/memories/count", async (c) => {
  try {
    const actorId = c.req.query("actorId");
    const memoryType = c.req.query("memoryType");
    const minImportance = c.req.query("minImportance");
    const count = await (await getMs()).memory.count({
      actorId,
      memoryType: memoryType as MemoryType | undefined,
      minImportance: minImportance ? parseFloat(minImportance) : undefined,
    });
    return c.json({ count });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.get("/v1/memories/export", async (c) => {
  try {
    const actorId = c.req.query("actorId");
    const snapshot = await (await getMs()).export(actorId);
    return c.json(snapshot);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.get("/v1/memories/:id", async (c) => {
  try {
    const memory = await (await getMs()).memory.get(c.req.param("id"));
    if (!memory) return c.json({ error: "Not found" }, 404);
    return c.json(memory);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.delete("/v1/memories/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const ms = await getMs();
    const existing = await ms.memory.get(id);
    if (!existing) return c.json({ deleted: false, error: "Not found" }, 404);
    await ms.memory.delete(id);
    return c.json({ deleted: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/delete-many", async (c) => {
  const parsed = await parseBody(c, DeleteManySchema);
  if (!parsed.ok) return parsed.response;
  try {
    const deleted = await (await getMs()).memory.deleteMany(parsed.data.ids);
    return c.json({ deleted });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/purge", async (c) => {
  const parsed = await parseBody(c, PurgeSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const count = await (await getMs()).memory.purgeActor(parsed.data.actorId);
    return c.json({ purged: count });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/merge", async (c) => {
  const parsed = await parseBody(c, MergeSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const memory = await (await getMs()).memory.merge(parsed.data.ids);
    return c.json(memory);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/process", async (c) => {
  const parsed = await parseBody(c, ProcessSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await (await getMs()).process(parsed.data);
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/:id/touch", async (c) => {
  try {
    await (await getMs()).memory.touch(c.req.param("id"));
    return c.json({ touched: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/import", async (c) => {
  const parsed = await parseBody(c, ImportSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const body = parsed.data;
    const memories = Array.isArray(body) ? body : body.memories;
    const exportedAt = Array.isArray(body) ? new Date().toISOString() : (body.exportedAt ?? new Date().toISOString());
    // The snapshot's memories come from a prior export() call; we validate the
    // envelope shape above but trust the memory contents rather than re-validating
    // every field of every memory.
    const snapshot = { version: 1 as const, memories, exportedAt } as unknown as MemStackSnapshot;
    await (await getMs()).import(snapshot);
    return c.json({ imported: memories.length }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/summarize", async (c) => {
  const parsed = await parseBody(c, SummarizeSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await (await getMs()).memory.summarize(parsed.data);
    return c.json({
      summarized: result.deletedCount,
      summaryId: result.summary.id,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/prune", async (c) => {
  const parsed = await parseBody(c, PruneStrategySchema);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await (await getMs()).memory.prune(parsed.data);
    return c.json({ pruned: result.count });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/prune/dry-run", async (c) => {
  const parsed = await parseBody(c, PruneStrategySchema);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await (await getMs()).memory.dryRunPrune(parsed.data);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.get("/v1/stats/:actorId", async (c) => {
  try {
    const actorId = c.req.param("actorId");
    const stats = await (await getMs()).memory.stats(actorId);
    return c.json(stats);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.get("/v1/summarize/stream", async (c) => {
  const actorId = c.req.query("actorId") ?? "default";
  const olderThan = c.req.query("olderThan");
  const skipMostRecent = c.req.query("skipMostRecent");
  const targetCount = c.req.query("targetCount");

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const ms = await getMs();
        const gen = ms.memory.summarizeStream({
          actorId,
          olderThan: olderThan ? new Date(olderThan) : undefined,
          skipMostRecent: skipMostRecent ? parseInt(skipMostRecent, 10) : undefined,
          targetCount: targetCount ? parseInt(targetCount, 10) : undefined,
        });

        for await (const { chunk, text } of gen) {
          const line = `data: ${JSON.stringify({ chunk, text })}\n\n`;
          controller.enqueue(new TextEncoder().encode(line));
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Internal error";
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

app.get("/health", async (c) => {
  try {
    const status = await (await getMs()).health();
    return c.json({
      status: status.storage ? "ok" : "degraded",
      storage: status.storage ? "connected" : "disconnected",
      version: pkg.version,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.get("/openapi.json", (c) => c.json(buildOpenApiDocument(pkg.version)));

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestCounts) {
    if (now > entry.reset) requestCounts.delete(key);
  }
}, 60000).unref();

const port = parseInt(process.env.PORT ?? "3000", 10);

// Bun and Deno auto-start an HTTP server from this shape when the module is
// run directly. Node has no equivalent — see serve.ts for the Node entry point.
export default { port, fetch: app.fetch };
