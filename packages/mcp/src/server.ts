import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MemStack } from "@memstack/core";
import type { MemStackConfig, PruneStrategy, MemoryType, Memory, MemStackSnapshot, ProcessInput, MemoryStoreInput, MemoryRetrieveQuery, ContextOptions, SummarizeOptions } from "@memstack/core";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

const TOOLS = [
    {
        name: "memory_process",
        description:
            "Store a memory with auto-enrichment (importance scoring, tag extraction, auto-summarization, auto-pruning). This is the primary method for recording interactions.",
        inputSchema: {
            type: "object" as const,
            properties: {
                content: { type: "string", description: "The memory content text" },
                actorId: { type: "string", description: "Actor ID. Defaults to the current session actor." },
                importance: { type: "number", description: "Importance score (0.0-1.0). Auto-scored if omitted." },
                tags: { type: "array", items: { type: "string" }, description: "Tags for categorization. Auto-extracted if omitted." },
                memoryType: { type: "string", description: "Memory type (interaction, summary, observation, fact, reflection). Default: interaction." },
                metadata: { type: "object", description: "Additional metadata key-value pairs" },
            },
            required: ["content"],
        },
    },
    {
        name: "memory_store",
        description:
            "Store a memory directly without enrichment. Use this when you already have importance/tags or want precise control.",
        inputSchema: {
            type: "object" as const,
            properties: {
                content: { type: "string", description: "The memory content text" },
                actorId: { type: "string", description: "Actor ID. Defaults to the current session actor." },
                importance: { type: "number", description: "Importance score 0.0-1.0. Default: 0.5." },
                tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
                memoryType: { type: "string", description: "Memory type (interaction, summary, observation, fact, reflection). Default: interaction." },
                metadata: { type: "object", description: "Additional metadata key-value pairs" },
            },
            required: ["content"],
        },
    },
    {
        name: "memory_store_batch",
        description:
            "Store multiple memories in one call, directly without enrichment. Embeddings (if configured) are computed in a single batched call for efficiency.",
        inputSchema: {
            type: "object" as const,
            properties: {
                memories: {
                    type: "array",
                    description: "Memories to store (at least 1).",
                    items: {
                        type: "object",
                        properties: {
                            content: { type: "string", description: "The memory content text" },
                            actorId: { type: "string", description: "Actor ID. Defaults to the current session actor." },
                            importance: { type: "number", description: "Importance score 0.0-1.0. Default: 0.5." },
                            tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
                            memoryType: { type: "string", description: "Memory type (interaction, summary, observation, fact, reflection). Default: interaction." },
                            metadata: { type: "object", description: "Additional metadata key-value pairs" },
                        },
                        required: ["content"],
                    },
                },
            },
            required: ["memories"],
        },
    },
    {
        name: "memory_get",
        description: "Get a single memory by ID. Returns null if not found.",
        inputSchema: {
            type: "object" as const,
            properties: {
                id: { type: "string", description: "Memory ID" },
            },
            required: ["id"],
        },
    },
    {
        name: "memory_retrieve",
        description: "Retrieve memories for an actor with optional filtering, semantic search, and date range constraints.",
        inputSchema: {
            type: "object" as const,
            properties: {
                query: { type: "string", description: "Semantic search query (used with semantic/hybrid strategies)" },
                strategy: {
                    type: "string",
                    enum: ["recent", "important", "semantic", "hybrid"],
                    description: "Retrieval strategy. Default: recent.",
                },
                limit: { type: "number", description: "Maximum number of memories to return" },
                tags: { type: "array", items: { type: "string" }, description: "Filter by tags (any match)" },
                memoryTypes: { type: "array", items: { type: "string" }, description: "Filter by memory types" },
                actorId: { type: "string", description: "Actor ID. Defaults to the current session actor." },
                createdAfter: { type: "string", description: "ISO-8601 date. Only memories created after this time." },
                createdBefore: { type: "string", description: "ISO-8601 date. Only memories created before this time." },
            },
        },
    },
    {
        name: "memory_compile_context",
        description:
            "Compile memories into an LLM-ready system prompt (markdown formatted, token-budgeted, split into important and recent sections).",
        inputSchema: {
            type: "object" as const,
            properties: {
                maxTokens: { type: "number", description: "Maximum tokens for the compiled context. Default: 2000." },
                memoryTypes: { type: "array", items: { type: "string" }, description: "Filter by memory types" },
                actorId: { type: "string", description: "Actor ID. Defaults to the current session actor." },
            },
        },
    },
    {
        name: "memory_summarize",
        description:
            "Summarize old memories into a single summary memory. Compresses N interactions into 1 summary via LLM.",
        inputSchema: {
            type: "object" as const,
            properties: {
                olderThan: { type: "string", description: "ISO-8601 date. Only summarize memories older than this." },
                skipMostRecent: { type: "number", description: "Skip the N most recent memories to preserve conversational freshness." },
                targetCount: { type: "number", description: "Maximum number of memories to summarize" },
                actorId: { type: "string", description: "Actor ID. Defaults to the current session actor." },
            },
        },
    },
    {
        name: "memory_prune",
        description:
            "Prune (delete) memories matching the given strategy. Scoped to a single actor — defaults to the current session actor. Returns the pruned memory IDs and count. Handle with care.",
        inputSchema: {
            type: "object" as const,
            properties: {
                type: {
                    type: "string",
                    enum: ["byAge", "byImportance", "byCount", "byType", "compose"],
                    description: "Prune strategy type. Note: 'custom' is not available via MCP because it requires a JS function.",
                },
                actorId: { type: "string", description: "Actor ID to scope pruning to. Defaults to the current session actor." },
                maxAge: { type: "number", description: "Max age in seconds (for byAge). Memories older than this are removed." },
                minImportance: { type: "number", description: "Minimum importance (for byImportance). Memories below this are removed." },
                maxPerActor: { type: "number", description: "Maximum memories per actor (for byCount). Excess memories are removed." },
                memoryTypes: { type: "array", items: { type: "string" }, description: "Memory types to prune (for byType)." },
            },
            required: ["type"],
        },
    },
    {
        name: "memory_purge_actor",
        description: "Delete ALL memories belonging to a specific actor. Irreversible.",
        inputSchema: {
            type: "object" as const,
            properties: {
                actorId: { type: "string", description: "Actor ID to purge. Defaults to the current session actor." },
            },
        },
    },
    {
        name: "memory_merge",
        description: "Merge multiple memories into one. Uses the highest-importance memory as the base and appends content from the rest.",
        inputSchema: {
            type: "object" as const,
            properties: {
                ids: { type: "array", items: { type: "string" }, description: "Memory IDs to merge (at least 2)" },
            },
            required: ["ids"],
        },
    },
    {
        name: "memory_stats",
        description: "Get memory statistics: total count, by type, by actor, average importance, and more.",
        inputSchema: {
            type: "object" as const,
            properties: {},
        },
    },
    {
        name: "memory_delete",
        description: "Delete a single memory by ID.",
        inputSchema: {
            type: "object" as const,
            properties: {
                id: { type: "string", description: "Memory ID to delete" },
            },
            required: ["id"],
        },
    },
    {
        name: "memory_delete_many",
        description: "Delete multiple memories by ID in one call. Returns the number actually deleted.",
        inputSchema: {
            type: "object" as const,
            properties: {
                ids: { type: "array", items: { type: "string" }, description: "Memory IDs to delete" },
            },
            required: ["ids"],
        },
    },
    {
        name: "memory_touch",
        description: "Bump a memory's recency (last-accessed timestamp) without changing its content, id, or createdAt.",
        inputSchema: {
            type: "object" as const,
            properties: {
                id: { type: "string", description: "Memory ID to touch" },
            },
            required: ["id"],
        },
    },
    {
        name: "memory_export",
        description: "Export a snapshot of memories for backup or migration. Returns { version, memories, exportedAt }.",
        inputSchema: {
            type: "object" as const,
            properties: {
                actorId: { type: "string", description: "Actor ID to export. Defaults to the current session actor." },
            },
        },
    },
    {
        name: "memory_import",
        description: "Import memories from a snapshot previously produced by memory_export. Restores each memory as-is, including its original ID.",
        inputSchema: {
            type: "object" as const,
            properties: {
                memories: { type: "array", items: { type: "object" }, description: "Memories to import, as produced by memory_export" },
            },
            required: ["memories"],
        },
    },
    {
        name: "memory_health",
        description: "Check the health of storage, LLM, and embedding connections.",
        inputSchema: {
            type: "object" as const,
            properties: {},
        },
    },
    {
        name: "memory_dry_run_prune",
        description:
            "Preview what would be pruned by a given strategy WITHOUT actually deleting. Scoped to a single actor — defaults to the current session actor. Returns the memory IDs that would be removed.",
        inputSchema: {
            type: "object" as const,
            properties: {
                type: {
                    type: "string",
                    enum: ["byAge", "byImportance", "byCount", "byType", "compose"],
                    description: "Prune strategy type to preview. Note: 'custom' is not available via MCP because it requires a JS function.",
                },
                actorId: { type: "string", description: "Actor ID to scope pruning to. Defaults to the current session actor." },
                maxAge: { type: "number", description: "Max age in seconds (for byAge)" },
                minImportance: { type: "number", description: "Minimum importance (for byImportance)" },
                maxPerActor: { type: "number", description: "Maximum memories per actor (for byCount)" },
                memoryTypes: { type: "array", items: { type: "string" }, description: "Memory types to evaluate (for byType)" },
            },
            required: ["type"],
        },
    },
];

interface MCPProcessArgs {
    content: string;
    actorId?: string;
    importance?: number;
    tags?: string[];
    memoryType?: string;
    metadata?: Record<string, unknown>;
}

interface MCPStoreArgs {
    content: string;
    actorId?: string;
    importance?: number;
    tags?: string[];
    memoryType?: string;
    metadata?: Record<string, unknown>;
}

interface MCPStoreBatchArgs {
    memories: MCPStoreArgs[];
}

interface MCPGetArgs {
    id: string;
}

interface MCPDeleteManyArgs {
    ids: string[];
}

interface MCPTouchArgs {
    id: string;
}

interface MCPExportArgs {
    actorId?: string;
}

interface MCPImportArgs {
    memories: Memory[];
}

interface MCPRetrieveArgs {
    actorId?: string;
    query?: string;
    strategy?: "recent" | "important" | "semantic" | "hybrid";
    limit?: number;
    tags?: string[];
    memoryTypes?: string[];
    createdAfter?: string;
    createdBefore?: string;
}

interface MCPCompileContextArgs {
    actorId?: string;
    maxTokens?: number;
    memoryTypes?: string[];
}

interface MCPSummarizeArgs {
    actorId?: string;
    olderThan?: string;
    skipMostRecent?: number;
    targetCount?: number;
}

interface MCPPruneArgs {
    type: "byAge" | "byImportance" | "byCount" | "byType" | "compose";
    actorId?: string;
    maxAge?: number;
    minImportance?: number;
    maxPerActor?: number;
    memoryTypes?: string[];
}

interface MCPPurgeArgs {
    actorId?: string;
}

interface MCPMergeArgs {
    ids: string[];
}

interface MCPDeleteArgs {
    id: string;
}

function buildPruneStrategy(args: MCPPruneArgs, defaultActorId: string): PruneStrategy {
    const VALID_TYPES = ["byAge", "byImportance", "byCount", "byType", "custom", "compose"];
    const type = args.type ?? "byAge";
    if (!VALID_TYPES.includes(type)) {
        throw new Error(`Invalid prune type: ${type}. Valid: ${VALID_TYPES.join(", ")}`);
    }
    return {
        type: type as PruneStrategy["type"],
        actorId: (args.actorId ?? defaultActorId).trim(),
        maxAge: args.maxAge,
        minImportance: args.minImportance,
        maxPerActor: args.maxPerActor,
        memoryTypes: args.memoryTypes as MemoryType[] | undefined,
    };
}

function sanitizeContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (content === null || content === undefined) return "";
    return String(content);
}

function sanitizeTags(tags: unknown): string[] | undefined {
    if (!Array.isArray(tags)) return undefined;
    const filtered = tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    return filtered.length > 0 ? filtered : undefined;
}

function clampImportance(importance: unknown): number | undefined {
    if (importance === undefined || importance === null) return undefined;
    const n = Number(importance);
    if (isNaN(n)) return undefined;
    return Math.max(0, Math.min(1, n));
}

export function createServer({
    config,
    defaultActorId,
    ms: providedMs,
}: {
    config: MemStackConfig;
    defaultActorId: string;
    /** Reuse an existing MemStack instance instead of constructing one from config. Used by HTTP mode to avoid reconnecting storage per request. */
    ms?: MemStack;
}): Server {
    const ms = providedMs ?? new MemStack(config);
    const server = new Server(
        { name: "memstack", version: pkg.version },
        { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;

        try {
            switch (request.params.name) {
                case "memory_process": {
                    const a = args as unknown as MCPProcessArgs;
                    const content = sanitizeContent(a.content);
                    if (!content) throw new Error("content is required and must be a non-empty string");
                    const input: ProcessInput = {
                        actorId: (a.actorId ?? defaultActorId).trim(),
                        content,
                        importance: clampImportance(a.importance),
                        tags: sanitizeTags(a.tags),
                        memoryType: a.memoryType as MemoryType | undefined,
                        metadata: a.metadata,
                    };
                    const result = await ms.process(input);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_store": {
                    const a = args as unknown as MCPStoreArgs;
                    const content = sanitizeContent(a.content);
                    if (!content) throw new Error("content is required and must be a non-empty string");
                    const input: MemoryStoreInput = {
                        actorId: (a.actorId ?? defaultActorId).trim(),
                        content,
                        importance: clampImportance(a.importance),
                        tags: sanitizeTags(a.tags),
                        memoryType: a.memoryType as MemoryType | undefined,
                        metadata: a.metadata,
                    };
                    const result = await ms.memory.store(input);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_store_batch": {
                    const a = args as unknown as MCPStoreBatchArgs;
                    const inputs: MemoryStoreInput[] = a.memories.map((m) => ({
                        actorId: (m.actorId ?? defaultActorId).trim(),
                        content: sanitizeContent(m.content),
                        importance: clampImportance(m.importance),
                        tags: sanitizeTags(m.tags),
                        memoryType: m.memoryType as MemoryType | undefined,
                        metadata: m.metadata,
                    }));
                    const result = await ms.memory.storeBatch(inputs);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_get": {
                    const a = args as unknown as MCPGetArgs;
                    const result = await ms.memory.get(a.id);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_retrieve": {
                    const a = args as unknown as MCPRetrieveArgs;
                    const query: MemoryRetrieveQuery = {
                        actorId: a.actorId ?? defaultActorId,
                        query: a.query,
                        strategy: a.strategy,
                        limit: a.limit,
                        tags: a.tags,
                        memoryTypes: a.memoryTypes as MemoryType[] | undefined,
                        createdAfter: a.createdAfter ? new Date(a.createdAfter) : undefined,
                        createdBefore: a.createdBefore ? new Date(a.createdBefore) : undefined,
                    };
                    const result = await ms.memory.retrieve(query);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_compile_context": {
                    const a = args as unknown as MCPCompileContextArgs;
                    const opts: ContextOptions = {
                        actorId: a.actorId ?? defaultActorId,
                        maxTokens: a.maxTokens,
                        memoryTypes: a.memoryTypes as MemoryType[] | undefined,
                    };
                    const result = await ms.memory.compileContext(opts);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_summarize": {
                    const a = args as unknown as MCPSummarizeArgs;
                    const opts: SummarizeOptions = {
                        actorId: a.actorId ?? defaultActorId,
                        olderThan: a.olderThan ? new Date(a.olderThan) : undefined,
                        skipMostRecent: a.skipMostRecent,
                        targetCount: a.targetCount,
                    };
                    const result = await ms.memory.summarize(opts);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_prune": {
                    const strategy = buildPruneStrategy(args as unknown as MCPPruneArgs, defaultActorId);
                    const result = await ms.memory.prune(strategy);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_purge_actor": {
                    const a = args as unknown as MCPPurgeArgs;
                    const result = await ms.memory.purgeActor(a.actorId ?? defaultActorId);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_merge": {
                    const a = args as unknown as MCPMergeArgs;
                    const result = await ms.memory.merge(a.ids);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_stats": {
                    const result = await ms.memory.stats();
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_delete": {
                    const a = args as unknown as MCPDeleteArgs;
                    await ms.memory.delete(a.id);
                    return {
                        content: [
                            { type: "text" as const, text: JSON.stringify({ deleted: true }, null, 2) },
                        ],
                    };
                }

                case "memory_delete_many": {
                    const a = args as unknown as MCPDeleteManyArgs;
                    const count = await ms.memory.deleteMany(a.ids);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ deleted: count }, null, 2) }],
                    };
                }

                case "memory_touch": {
                    const a = args as unknown as MCPTouchArgs;
                    await ms.memory.touch(a.id);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ touched: true }, null, 2) }],
                    };
                }

                case "memory_export": {
                    const a = args as unknown as MCPExportArgs;
                    const result = await ms.export(a.actorId ?? defaultActorId);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_import": {
                    const a = args as unknown as MCPImportArgs;
                    if (!a.memories || !Array.isArray(a.memories) || a.memories.length === 0) {
                        return {
                            content: [{ type: "text" as const, text: JSON.stringify({ imported: 0, message: "No memories to import" }, null, 2) }],
                            isError: true,
                        };
                    }
                    const snapshot: MemStackSnapshot = {
                        version: 1,
                        memories: a.memories,
                        exportedAt: new Date().toISOString(),
                    };
                    await ms.import(snapshot);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ imported: a.memories.length }, null, 2) }],
                    };
                }

                case "memory_health": {
                    const result = await ms.health();
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                case "memory_dry_run_prune": {
                    const strategy = buildPruneStrategy(args as unknown as MCPPruneArgs, defaultActorId);
                    const result = await ms.memory.dryRunPrune(strategy);
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    };
                }

                default:
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({ error: `Unknown tool: ${request.params.name}` }),
                            },
                        ],
                        isError: true,
                    };
            }
        } catch (err) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
                    },
                ],
                isError: true,
            };
        }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [
            {
                uri: "memory://{actorId}/context",
                name: "Actor Memory Context",
                description: "Compiled LLM-ready context for an actor",
                mimeType: "text/markdown",
            },
            {
                uri: "memory://{actorId}/stats",
                name: "Actor Memory Stats",
                description: "Diagnostic stats for actor memory",
                mimeType: "application/json",
            },
        ],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const uri = request.params.uri;

        try {
            const parsed = uri.match(/^memory:\/\/([^/]+)\/(.+)$/);
            if (!parsed) {
                return {
                    contents: [
                        {
                            uri,
                            mimeType: "text/plain",
                            text: JSON.stringify({ error: `Invalid resource URI: ${uri}` }),
                        },
                    ],
                };
            }

            const [, resourceActorId, resource] = parsed;

            if (resource === "context") {
                const ctx = await ms.memory.compileContext({ actorId: resourceActorId });
                return {
                    contents: [
                        { uri, mimeType: "text/markdown", text: ctx.systemPrompt },
                    ],
                };
            }

            if (resource === "stats") {
                const stats = await ms.memory.stats();
                const byActor = stats.byActor[resourceActorId];
                const result = byActor
                    ? { actorId: resourceActorId, ...byActor, total: stats.total }
                    : { actorId: resourceActorId, count: 0, total: stats.total };
                return {
                    contents: [
                        { uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) },
                    ],
                };
            }

            return {
                contents: [
                    {
                        uri,
                        mimeType: "text/plain",
                        text: JSON.stringify({ error: `Unknown resource: ${resource}` }),
                    },
                ],
            };
        } catch (err) {
            return {
                contents: [
                    {
                        uri,
                        mimeType: "text/plain",
                        text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
                    },
                ],
            };
        }
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: [
            {
                name: "memory_context",
                description: "Injects compiled memory context for the current actor",
                arguments: [
                    {
                        name: "actorId",
                        description: "Actor ID (defaults to session actor)",
                        required: false,
                    },
                ],
            },
        ],
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        try {
            const promptActorId =
                request.params.arguments?.actorId ?? defaultActorId;
            const ctx = await ms.memory.compileContext({ actorId: promptActorId });
            return {
                messages: [
                    {
                        role: "assistant" as const,
                        content: { type: "text" as const, text: ctx.systemPrompt },
                    },
                ],
            };
        } catch (err) {
            return {
                messages: [
                    {
                        role: "assistant" as const,
                        content: {
                            type: "text" as const,
                            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                        },
                    },
                ],
            };
        }
    });

    return server;
}
