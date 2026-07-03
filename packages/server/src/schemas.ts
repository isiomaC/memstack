import { z } from "zod";

export const MemoryTypeSchema = z.enum(["interaction", "summary", "observation", "fact", "reflection"]);

const isoDate = z.iso.datetime({ offset: true }).or(z.iso.date()).transform((s) => new Date(s));

export const StoreMemorySchema = z.object({
  actorId: z.string().min(1),
  content: z.string().min(1),
  memoryType: MemoryTypeSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  emotionalValence: z.number().min(-1).max(1).optional(),
  tags: z.array(z.string()).optional(),
  embedding: z.array(z.number()).optional(),
  sourceId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresAt: isoDate.optional(),
  onConflict: z.literal("append").optional(),
  id: z.string().optional(),
});

export const BatchStoreSchema = z.object({
  memories: z.array(StoreMemorySchema).min(1),
});

export const RetrieveSchema = z.object({
  actorId: z.string().optional(),
  query: z.string().optional(),
  memoryTypes: z.array(MemoryTypeSchema).optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().positive().optional(),
  strategy: z.enum(["semantic", "hybrid", "recent", "important"]).optional(),
  createdAfter: isoDate.optional(),
  createdBefore: isoDate.optional(),
});

export const ContextSchema = z.object({
  actorId: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  memoryTypes: z.array(MemoryTypeSchema).optional(),
  retrieveStrategy: z.enum(["recent", "important", "hybrid"]).optional(),
  format: z.enum(["markdown", "messages"]).optional(),
});

export const ProcessSchema = z.object({
  actorId: z.string().min(1),
  content: z.string().min(1),
  memoryType: MemoryTypeSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  emotionalValence: z.number().min(-1).max(1).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresAt: isoDate.optional(),
  onConflict: z.literal("append").optional(),
});

export const SummarizeSchema = z.object({
  actorId: z.string().optional(),
  olderThan: isoDate.optional(),
  skipMostRecent: z.number().int().nonnegative().optional(),
  targetCount: z.number().int().positive().optional(),
  memoryTypes: z.array(MemoryTypeSchema).optional(),
  keepOriginals: z.boolean().optional(),
  chunkSize: z.number().int().positive().optional(),
  prompt: z.string().optional(),
});

export interface RestPruneStrategy {
  type: "byAge" | "byImportance" | "byCount" | "byType" | "compose";
  maxAge?: number;
  minImportance?: number;
  maxPerActor?: number;
  memoryTypes?: z.infer<typeof MemoryTypeSchema>[];
  strategies?: RestPruneStrategy[];
}

// "custom" prune (a JS predicate function) can't cross JSON, so it's excluded
// from the REST-reachable type set — everything else in PruneStrategy is.
export const PruneStrategySchema: z.ZodType<RestPruneStrategy> = z.lazy(() =>
  z.object({
    type: z.enum(["byAge", "byImportance", "byCount", "byType", "compose"]),
    maxAge: z.number().nonnegative().optional(),
    minImportance: z.number().min(0).max(1).optional(),
    maxPerActor: z.number().int().positive().optional(),
    memoryTypes: z.array(MemoryTypeSchema).optional(),
    strategies: z.array(PruneStrategySchema).optional(),
  }),
);

export const MergeSchema = z.object({
  ids: z.array(z.string()).min(2),
});

export const PurgeSchema = z.object({
  actorId: z.string().min(1),
});

export const DeleteManySchema = z.object({
  ids: z.array(z.string()).min(1),
});

export const ImportSchema = z.union([
  z.array(z.unknown()),
  z.object({
    version: z.number().optional(),
    memories: z.array(z.unknown()),
    exportedAt: z.string().optional(),
  }),
]);
