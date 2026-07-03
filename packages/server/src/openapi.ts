import { z } from "zod";
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

interface RouteDoc {
  method: "get" | "post" | "delete";
  path: string;
  summary: string;
  requestSchema?: z.ZodType;
  successStatus: number;
}

const ROUTES: RouteDoc[] = [
  { method: "post", path: "/v1/memories", summary: "Store a memory", requestSchema: StoreMemorySchema, successStatus: 201 },
  { method: "post", path: "/v1/memories/batch", summary: "Store multiple memories", requestSchema: BatchStoreSchema, successStatus: 201 },
  { method: "post", path: "/v1/memories/retrieve", summary: "Retrieve memories", requestSchema: RetrieveSchema, successStatus: 200 },
  { method: "post", path: "/v1/memories/context", summary: "Compile LLM-ready context", requestSchema: ContextSchema, successStatus: 200 },
  { method: "get", path: "/v1/memories/count", summary: "Count memories matching filters", successStatus: 200 },
  { method: "get", path: "/v1/memories/export", summary: "Export a memory snapshot", successStatus: 200 },
  { method: "get", path: "/v1/memories/{id}", summary: "Get a memory by ID", successStatus: 200 },
  { method: "delete", path: "/v1/memories/{id}", summary: "Delete a memory by ID", successStatus: 200 },
  { method: "post", path: "/v1/memories/delete-many", summary: "Delete multiple memories by ID", requestSchema: DeleteManySchema, successStatus: 200 },
  { method: "post", path: "/v1/memories/purge", summary: "Delete all memories for an actor", requestSchema: PurgeSchema, successStatus: 200 },
  { method: "post", path: "/v1/memories/merge", summary: "Merge multiple memories into one", requestSchema: MergeSchema, successStatus: 200 },
  { method: "post", path: "/v1/memories/process", summary: "Store a memory with auto-enrichment", requestSchema: ProcessSchema, successStatus: 201 },
  { method: "post", path: "/v1/memories/{id}/touch", summary: "Bump a memory's recency", successStatus: 200 },
  { method: "post", path: "/v1/memories/import", summary: "Import a memory snapshot", requestSchema: ImportSchema, successStatus: 201 },
  { method: "post", path: "/v1/summarize", summary: "Compress old memories into a summary", requestSchema: SummarizeSchema, successStatus: 200 },
  { method: "get", path: "/v1/summarize/stream", summary: "Stream summarization via SSE", successStatus: 200 },
  { method: "post", path: "/v1/prune", summary: "Remove stale/low-value memories", requestSchema: PruneStrategySchema, successStatus: 200 },
  { method: "post", path: "/v1/prune/dry-run", summary: "Preview what a prune strategy would remove", requestSchema: PruneStrategySchema, successStatus: 200 },
  { method: "get", path: "/v1/stats/{actorId}", summary: "Memory diagnostics for an actor", successStatus: 200 },
  { method: "get", path: "/health", summary: "Health check", successStatus: 200 },
];

/**
 * Hand-maintained route list, but request body shapes are generated from the
 * same zod schemas that validate incoming requests — one source of truth.
 */
export function buildOpenApiDocument(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    const pathItem = (paths[route.path] ??= {});
    const pathParams = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    pathItem[route.method] = {
      summary: route.summary,
      ...(pathParams.length ? { parameters: pathParams } : {}),
      ...(route.requestSchema
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: z.toJSONSchema(route.requestSchema, { io: "input" }) } },
            },
          }
        : {}),
      responses: {
        [String(route.successStatus)]: { description: "Success" },
        ...(route.requestSchema ? { "400": { description: "Validation failed" } } : {}),
        "500": { description: "Internal error" },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "MemStack Server API",
      version,
      description: "REST API for MemStack — self-hostable agent memory. See https://github.com/isiomaC/memstack for the full guide.",
    },
    servers: [{ url: "/" }],
    paths,
  };
}
