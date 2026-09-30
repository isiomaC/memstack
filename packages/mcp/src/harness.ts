// Harness MCP profile (ADR 0001, D6): five tools for agent harnesses such as
// Claude Code and Codex, scoped to the project the harness was started in.
// Tools take no actorId, so one project can never read or delete another's
// memories, and bulk or destructive tools are not exposed.
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  GLOBAL_NAMESPACE,
  MemStackError,
  defaultRecallNamespaces,
  projectNamespace,
} from "@memstack/core";
import type { HarnessMemory, Memory, MemoryType } from "@memstack/core";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

const KINDS = [
  "fact", "preference", "decision", "instruction", "observation",
  "interaction", "summary", "reflection",
] as const satisfies readonly MemoryType[];

export const HARNESS_INSTRUCTIONS = [
  "MemStack is this project's persistent memory, shared with other coding agents.",
  "When the user asks you to remember something, call memory_store. Do not write it into README, AGENTS.md, or other project files unless the user asks for a file change.",
  "Also call memory_store when you learn a durable fact, decision, preference, or rule.",
  "Call memory_retrieve at the start of a task and before decisions that depend on project history, conventions, or preferences.",
  "Never store secrets, credentials, or personal data.",
  "",
  'Store one self-contained statement per memory, e.g. "This project uses Hono for the API". Memories are project-scoped; use scope "global" only for preferences that apply to every project. memory_retrieve takes natural-language questions. Cite memory IDs when you rely on them, and delete memories that turn out to be wrong with memory_delete.',
].join("\n");

const StoreArgs = z.object({
  content: z.string().trim().min(1).max(8000).describe("One self-contained statement to remember."),
  kind: z.enum(KINDS).default("fact").describe("What kind of memory this is."),
  importance: z.number().min(0).max(1).optional().describe("0 to 1. Default 0.5; use 0.8+ for rules that must not be missed."),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional().describe("Optional topic tags. MemStack adds its own."),
  scope: z.enum(["project", "global"]).default("project").describe('"global" only for preferences that apply to every project.'),
}).strict();

const RetrieveArgs = z.object({
  query: z.string().max(1000).optional().describe("Natural-language question or keywords. Omit to get the most important memories."),
  limit: z.number().int().min(1).max(25).default(10).describe("Maximum memories to return."),
  kinds: z.array(z.enum(KINDS)).optional().describe("Only return these kinds."),
}).strict();

const IdArgs = z.object({ id: z.string().min(1).max(200) }).strict();
const NoArgs = z.object({}).strict();

const TOOLS = [
  {
    name: "memory_store",
    description: "Save to project memory. Use this whenever the user asks you to remember something, instead of editing project files, and for durable facts, decisions, preferences, or rules. Later sessions and other agents can recall it.",
    schema: StoreArgs,
  },
  {
    name: "memory_retrieve",
    description: "Recall memories for this project (and global preferences) relevant to a question. Fast and local; call it freely.",
    schema: RetrieveArgs,
  },
  { name: "memory_get", description: "Get one memory by ID.", schema: IdArgs },
  { name: "memory_delete", description: "Delete a memory that is wrong or outdated, by ID.", schema: IdArgs },
  { name: "memory_stats", description: "Show the current project and how many memories it has.", schema: NoArgs },
] as const;

/** Characters of memory content returned by one memory_retrieve call. */
const RECALL_MAX_CHARS = 8000;

export interface HarnessServerOptions {
  memory: HarnessMemory;
  projectId: string;
  /** Harness that launched the server, e.g. "claude-code". Falls back to the MCP client's name. */
  harness?: string;
  cwd?: string;
}

export function createHarnessServer({ memory, projectId, harness, cwd }: HarnessServerOptions): Server {
  const server = new Server(
    { name: "memstack", version: pkg.version },
    { capabilities: { tools: {} }, instructions: HARNESS_INSTRUCTIONS },
  );
  const project = projectNamespace(projectId);
  const namespaces = defaultRecallNamespaces(projectId);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, schema }) => ({
      name,
      description,
      inputSchema: z.toJSONSchema(schema, { io: "input" }) as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) return failure(`Unknown tool: ${request.params.name}`);

    const parsed = tool.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return failure(`Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`);
    }

    try {
      switch (tool.name) {
        case "memory_store": {
          const args = parsed.data as z.output<typeof StoreArgs>;
          const stored = await memory.remember({
            namespace: args.scope === "global" ? GLOBAL_NAMESPACE : project,
            content: args.content,
            kind: args.kind,
            importance: args.importance,
            tags: args.tags,
            source: {
              harness: harness ?? server.getClientVersion()?.name ?? "unknown",
              project: projectId,
              cwd,
            },
          });
          return text(`Stored ${stored.id} (${args.scope}, ${stored.memoryType}). Tags: ${stored.tags.join(", ") || "none"}.`);
        }

        case "memory_retrieve": {
          const args = parsed.data as z.output<typeof RetrieveArgs>;
          const { hits, fallback } = await memory.recall({
            namespaces,
            query: args.query,
            kinds: args.kinds,
            limit: args.limit,
            maxChars: RECALL_MAX_CHARS,
          });
          if (hits.length === 0) return text("No memories yet for this project.");
          const header = fallback && args.query
            ? `Nothing matched "${args.query}". The most important memories instead:`
            : `${hits.length} ${hits.length === 1 ? "memory" : "memories"}:`;
          return text([header, ...hits.map(({ memory: m }) => formatMemory(m, projectId))].join("\n"));
        }

        case "memory_get": {
          const { id } = parsed.data as z.output<typeof IdArgs>;
          const found = await memory.get(id, namespaces);
          return found ? text(formatMemory(found, projectId, true)) : failure(`Memory not found in this project: ${id}`);
        }

        case "memory_delete": {
          const { id } = parsed.data as z.output<typeof IdArgs>;
          await memory.forget(id, namespaces);
          return text(`Deleted ${id}.`);
        }

        case "memory_stats": {
          const counts = await memory.stats(namespaces);
          return text(
            `Project ${projectId}${cwd ? ` (${cwd})` : ""}: ${counts[project] ?? 0} memories. Global: ${counts[GLOBAL_NAMESPACE] ?? 0}.`,
          );
        }
      }
    } catch (error) {
      if (error instanceof MemStackError && error.code === "NOT_FOUND") {
        return failure(`Memory not found in this project: ${(parsed.data as { id?: string }).id ?? ""}`);
      }
      return failure(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

function formatMemory(m: Memory, projectId: string, detailed = false): string {
  const scope = m.actorId === GLOBAL_NAMESPACE ? "global" : "project";
  const source = (m.metadata?.source as { harness?: string } | undefined)?.harness;
  const meta = [m.memoryType, scope, source && `from ${source}`, m.createdAt.toISOString().slice(0, 10)].filter(Boolean);
  const line = `- [${m.id}] ${m.content} (${meta.join(", ")})`;
  if (!detailed) return line;
  return `${line}\nimportance: ${m.importance}\ntags: ${m.tags.join(", ") || "none"}\nproject: ${scope === "project" ? projectId : "all"}`;
}

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
