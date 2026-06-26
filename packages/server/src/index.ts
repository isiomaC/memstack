import { Hono } from "hono";
import { MemStack } from "@memstack/core";
import type { MemoryType } from "@memstack/core";
import { loadConfig } from "./config.js";

const app = new Hono();

let _ms: MemStack | null = null;
async function getMs(): Promise<MemStack> {
  if (!_ms) {
    _ms = new MemStack(await loadConfig());
  }
  return _ms;
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
  try {
    const body = await c.req.json();
    const memory = await (await getMs()).memory.store(body);
    return c.json(memory, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/batch", async (c) => {
  try {
    const { memories } = await c.req.json();
    const result = await (await getMs()).memory.storeBatch(memories);
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/retrieve", async (c) => {
  try {
    const body = await c.req.json();
    const results = await (await getMs()).memory.retrieve(body);
    return c.json(results);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/context", async (c) => {
  try {
    const body = await c.req.json();
    const ctx = await (await getMs()).memory.compileContext(body);
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
  try {
    const { ids } = await c.req.json();
    const deleted = await (await getMs()).memory.deleteMany(ids);
    return c.json({ deleted });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/purge", async (c) => {
  try {
    const { actorId } = await c.req.json();
    const count = await (await getMs()).memory.purgeActor(actorId);
    return c.json({ purged: count });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/merge", async (c) => {
  try {
    const { ids } = await c.req.json();
    const memory = await (await getMs()).memory.merge(ids);
    return c.json(memory);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/memories/process", async (c) => {
  try {
    const body = await c.req.json();
    const result = await (await getMs()).process(body);
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
  try {
    const body = await c.req.json();
    const snapshot = Array.isArray(body) ? { version: 1 as const, memories: body, exportedAt: new Date().toISOString() } : body;
    await (await getMs()).import(snapshot);
    return c.json({ imported: snapshot.memories?.length ?? 0 }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/summarize", async (c) => {
  try {
    const body = await c.req.json();
    const result = await (await getMs()).memory.summarize(body);
    return c.json({
      summarized: result.deletedCount,
      summaryId: result.summary.id,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/prune", async (c) => {
  try {
    const body = await c.req.json();
    const result = await (await getMs()).memory.prune(body);
    return c.json({ pruned: result.count });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

app.post("/v1/prune/dry-run", async (c) => {
  try {
    const body = await c.req.json();
    const result = await (await getMs()).memory.dryRunPrune(body);
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
      version: "0.6.1",
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestCounts) {
    if (now > entry.reset) requestCounts.delete(key);
  }
}, 60000).unref();

const port = parseInt(process.env.PORT ?? "3000", 10);
export default { port, fetch: app.fetch };
