# MemStack

> Open-source AI memory framework — store, retrieve, summarize, and prune memories for LLM agents and games.

[![npm version](https://img.shields.io/npm/v/@memstack/core)](https://www.npmjs.com/package/@memstack/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**MemStack** gives your AI agents persistent memory. It handles the full memory lifecycle — storing interactions, retrieving relevant context, summarizing old memories, pruning stale ones, tracking entity relationships, and managing quests/state. One method call (`process()`) orchestrates it all.

Think of it as the open-source alternative to [Mem0](https://mem0.ai/), but with pluggable storage, multi-dimensional relationships, and quest tracking built in.

```bash
npm install @memstack/core
```

---

## Table of Contents

- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
  - [Memory](#memory)
  - [Relationship](#relationship)
  - [Quest](#quest)
  - [Compiled Context](#compiled-context)
- [Adapters](#adapters)
  - [LLM Adapters](#llm-adapters)
  - [Embedding Adapters](#embedding-adapters)
  - [Storage Adapters](#storage-adapters)
- [API Reference](#api-reference)
  - [MemStack Client](#memstack-client)
  - [Memory Subsystem](#memory-subsystem)
  - [Relationship Subsystem](#relationship-subsystem)
  - [Quest Subsystem](#quest-subsystem)
  - [Export / Import](#export--import)
  - [Health Checks](#health-checks)
- [Configuration](#configuration)
- [Advanced Usage](#advanced-usage)
  - [Custom Storage](#custom-storage)
  - [Custom LLM Provider](#custom-llm-provider)
  - [Custom Embedding Provider](#custom-embedding-provider)
  - [Event Hooks](#event-hooks)
- [Memory Lifecycle](#memory-lifecycle)
  - [Summarization](#summarization)
  - [Pruning](#pruning)
  - [Embeddings](#embeddings)
- [Development](#development)
  - [Setup](#setup)
  - [Running Tests](#running-tests)
  - [Building](#building)
  - [Debugging](#debugging)
- [Publishing to npm](#publishing-to-npm)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

```typescript
import { MemStack, InMemoryStorage, OpenAILLMAdapter, OpenAIEmbeddingAdapter } from "@memstack/core";

// 1. Set up adapters
const memstack = new MemStack({
  llm: new OpenAILLMAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
  embedding: new OpenAIEmbeddingAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
  storage: new InMemoryStorage(),
});

// 2. Store an interaction — one call does memory + relationships + quests
const result = await memstack.process({
  actorId: "npc_elena",
  content: "The player saved my cat from the goblins.",
  targetId: "player_1",
  emotionalValence: 0.8,
  tags: ["quest", "rescue"],
  relationshipDelta: { affinity: 20, trust: 15 },
});

console.log(result.memory.id);           // "mem_..."
console.log(result.relationshipUpdate);  // { previous: null, current: { affinity: 20, ... } }

// 3. Ask what this NPC remembers — get an LLM-ready context block
const ctx = await memstack.memory.compileContext({ actorId: "npc_elena" });
console.log(ctx.systemPrompt);
// ## Important Memories
// - The player saved my cat from the goblins. (interaction, importance: 0.50)
// 
// ## Recent Interactions
// - The player saved my cat from the goblins.
console.log(ctx.tokenEstimate);  // ~125
```

---

## Core Concepts

### Memory

A `Memory` represents one unit of knowledge — an interaction, an observation, a summary, or gossip. Every memory is owned by an actor (NPC, agent, user).

```typescript
interface Memory {
  id: string;                    // Auto-generated, e.g. "mem_lx4g7a_abc123de"
  actorId: string;               // Who this memory belongs to
  memoryType: "interaction" | "summary" | "observation" | "gossip";
  content: string;               // The actual text
  importance: number;            // 0–1, affects retrieval order and pruning survival
  emotionalValence: number;      // -1 (negative) to 1 (positive)
  tags: string[];                // Auto or manually tagged: "combat", "quest", "trade"
  embedding?: number[];          // Populated if you configure an embedding adapter
  sourceId?: string;             // Links back to the originating interaction
  metadata?: Record<string, unknown>;  // Your custom data
  expiresAt?: Date;              // Auto-pruned after this time
  createdAt: Date;
}
```

**Memory types:**
| Type | Purpose |
|------|---------|
| `interaction` | Standard interaction — the default. Bulk of your memories. |
| `summary` | Compressed representation of N old interactions (created by `summarize()`). |
| `observation` | Passive observation — something the actor noticed without interacting. |
| `gossip` | Information spread between entities — used for world memory. |

### Relationship

A `Relationship` tracks how one entity feels about another. It's **directed** — NPC Elena's feelings about the player are tracked separately from the player's feelings about Elena.

```typescript
interface Relationship {
  actorA: string;      // Source entity (the one who feels)
  actorB: string;      // Target entity (the one being felt about)
  affinity: number;    // -100 (hate) to 100 (love)
  trust: number;       // -100 to 100
  fear: number;        // 0 to 100
  respect: number;     // 0 to 100
  stage: RelationshipStage;  // Auto-calculated: stranger → acquaintance → friend → ...
  interactionCount: number;  // How many times they've interacted
  historySummary?: string;   // LLM-generated summary of relationship history
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}
```

**Relationship stages** (auto-derived from `affinity`):

| Stage | Affinity Range |
|-------|---------------|
| `stranger` | 0–10 |
| `acquaintance` | 10–30 |
| `friend` | 30–60 |
| `close_friend` | 60–80 |
| `romantic` | 80–100 |
| `rival` | -30 to -60 |
| `nemesis` | -60 to -100 |

### Quest

A `Quest` tracks objectives, progress, rewards, and prerequisites. Full lifecycle: `offered` → `accepted` → `in_progress` → `completed` | `failed` | `expired`.

```typescript
interface Quest {
  id: string;
  title: string;
  description: string;
  giverId: string;         // NPC who gave the quest
  takerId?: string;        // Player who accepted it
  status: "offered" | "accepted" | "in_progress" | "completed" | "failed" | "expired";
  objectives: QuestObjective[];
  rewards?: { gold?: number; items?: string[]; relationshipBonus?: Record<string, number> };
  timeLimit?: Date;         // Auto-fails if past deadline
  prerequisites?: string[]; // Quest IDs that must be completed first
  createdAt: Date;
  updatedAt: Date;
}
```

### Compiled Context

The output of `compileContext()` — everything you need to inject into an LLM prompt:

```typescript
interface CompiledContext {
  systemPrompt: string;          // Assembled prompt with memories and relationships
  recentMemories: Memory[];      // Last N interactions
  importantMemories: Memory[];   // High-importance, deduplicated
  relationships: Relationship[]; // Relevant relationship data
  activeQuests: Quest[];         // In-progress quests
  tokenEstimate: number;         // Approximate token count
}
```

Use `compileContext()` as your prompt's system message:

```typescript
const ctx = await memstack.memory.compileContext({
  actorId: "npc_elena",
  maxTokens: 2000,
  includeRelationships: true,
  includeQuests: true,
});

const response = await llm.complete({
  system: ctx.systemPrompt,
  user: "The player approaches you. What do you say?",
});
```

---

## Adapters

MemStack is provider-agnostic. Everything is pluggable — bring your own LLM, embedding model, and storage backend.

### LLM Adapters

LLM adapters are used by `summarize()` and `compileContext()`. Ship with OpenAI and Anthropic built-in.

#### OpenAI

```typescript
import { OpenAILLMAdapter } from "@memstack/core";

const llm = new OpenAILLMAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: "gpt-4o-mini",     // optional, default
  baseURL: "https://api.openai.com/v1", // optional, for proxies
});
```

#### Anthropic

```typescript
import { AnthropicLLMAdapter } from "@memstack/core";

const llm = new AnthropicLLMAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  defaultModel: "claude-sonnet-4-5-20250929",
});
```

#### Ollama (custom adapter example)

```typescript
import type { LLMProvider } from "@memstack/core";

class OllamaAdapter implements LLMProvider {
  constructor(private baseURL = "http://localhost:11434") {}

  async complete(request: { system: string; user: string; model?: string }) {
    const response = await fetch(`${this.baseURL}/api/generate`, {
      method: "POST",
      body: JSON.stringify({
        model: request.model ?? "llama3.2",
        prompt: `${request.system}\n\n${request.user}`,
        stream: false,
      }),
    });
    const data = await response.json();
    return {
      text: data.response,
      tokens: { prompt: 0, completion: 0, total: 0 },
    };
  }
}
```

### Embedding Adapters

Embedding adapters are used for semantic retrieval (`strategy: "semantic"`). Ship with OpenAI built-in.

```typescript
import { OpenAIEmbeddingAdapter } from "@memstack/core";

const embedding = new OpenAIEmbeddingAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "text-embedding-3-small",  // default, 1536 dimensions
  // model: "text-embedding-3-large", // 3072 dimensions
});
```

**Embeddings are optional.** Without an embedding adapter, retrieval uses keyword matching + importance/recency sorting. With embeddings, `strategy: "semantic"` or `"hybrid"` performs true semantic search.

### Storage Adapters

Ship with `InMemoryStorage`. Build your own by implementing the `StorageProvider` interface for Postgres, Redis, filesystem, etc.

#### InMemoryStorage (default, zero setup)

```typescript
import { InMemoryStorage } from "@memstack/core";

const storage = new InMemoryStorage();
// All data lives in process memory — lost on restart.
// Perfect for development, testing, and prototyping.
```

#### Custom Storage (Postgres example)

```typescript
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "@memstack/core";
import type { Memory } from "@memstack/core";

class PostgresStorage implements StorageProvider {
  async initialize() { /* create tables */ }
  async store(input: MemoryStoreInput): Promise<Memory> { /* INSERT */ }
  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> { /* batch INSERT */ }
  async get(id: string): Promise<Memory | null> { /* SELECT by id */ }
  async delete(id: string): Promise<void> { /* DELETE */ }
  async deleteMany(ids: string[]): Promise<number> { /* DELETE WHERE id IN */ }
  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> { /* SELECT with filters */ }
  async count(filter?: MemoryCountFilter): Promise<number> { /* SELECT COUNT */ }
  async close(): Promise<void> { /* close pool */ }
}
```

See `src/adapters/storage/memory.ts` for a complete reference implementation.

---

## API Reference

### MemStack Client

```typescript
import { MemStack } from "@memstack/core";

const ms = new MemStack({ llm: /* required */, embedding?: /* optional */, storage?: /* optional */ });
```

#### `ms.process(input)`

The main method. One call stores a memory, updates relationships, checks quest triggers, and auto-summarizes/auto-prunes if thresholds are hit.

```typescript
const result = await ms.process({
  actorId: string;             // Required — who is experiencing this
  content: string;             // Required — what happened
  memoryType?: MemoryType;     // Default: "interaction"
  importance?: number;         // 0–1, auto-calculated if omitted
  emotionalValence?: number;   // -1 to 1, auto-detected if omitted
  tags?: string[];             // Auto-tagged if omitted
  targetId?: string;           // If interacting with another entity
  relationshipDelta?: {
    affinity?: number;         // Delta, not absolute. +5 means "trust increased by 5"
    trust?: number;
    fear?: number;
    respect?: number;
  };
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
});

// Returns:
interface ProcessResult {
  memory: Memory;
  relationshipUpdate?: { previous: Relationship; current: Relationship };
  questTriggers?: Quest[];     // Quests advanced by this interaction
  summaryCreated?: Memory;     // If summarization threshold was hit
}
```

#### `ms.export()` / `ms.import()`

Snapshot and restore full state:

```typescript
// Save everything
const snapshot = await ms.export();
fs.writeFileSync("state.json", JSON.stringify(snapshot));

// Restore
const data = JSON.parse(fs.readFileSync("state.json", "utf-8"));
await ms.import(data);
```

#### `ms.health()`

Check if all adapters are reachable:

```typescript
const status = await ms.health();
// { storage: true, llm: true, embedding: true }
```

#### `ms.close()`

Graceful shutdown — closes storage connections, embeds any pending memories:

```typescript
await ms.close();
```

---

### Memory Subsystem

Access via `ms.memory.*`:

#### `store(input)` / `storeBatch(inputs)`

```typescript
const mem = await ms.memory.store({
  actorId: "agent_1",
  content: "The user asked about their billing history.",
  memoryType: "interaction",
  importance: 0.7,
  tags: ["billing", "support"],
});

// Batch
const mems = await ms.memory.storeBatch([
  { actorId: "agent_1", content: "Question 1" },
  { actorId: "agent_1", content: "Question 2" },
]);
```

If `embedOnStore` is enabled (default), embeddings are computed automatically. Set `embedOnStore: false` in config to compute embeddings lazily.

#### `retrieve(query)`

```typescript
const memories = await ms.memory.retrieve({
  actorId: "agent_1",           // Filter by actor
  query: "billing",             // Semantic or keyword search
  memoryTypes: ["interaction"], // Only certain types
  tags: ["support"],            // Only certain tags
  limit: 10,                    // Max results (default 10)
  strategy: "hybrid",           // "semantic" | "hybrid" | "recent" | "important"
});
```

**Retrieval strategies:**
| Strategy | Behavior | Requires Embeddings |
|----------|----------|--------------------|
| `recent` | Most recent first | No |
| `important` | Highest importance first | No |
| `semantic` | Cosine similarity search | Yes |
| `hybrid` | Semantic + importance sorting | Yes |

If no embedding adapter is configured, `semantic` and `hybrid` fall back to keyword search + importance sorting.

#### `compileContext(options)`

Assembles an LLM-ready context block from memories:

```typescript
const ctx = await ms.memory.compileContext({
  actorId: "npc_elena",
  targetId: "player_1",       // Enrich with relationship context
  maxTokens: 2000,            // Soft cap (estimates tokens, doesn't truncate mid-word)
  includeRelationships: true, // Inject relationship summaries into prompt
  includeQuests: true,        // Inject active quests into prompt
  memoryTypes: ["interaction", "summary"], // Only certain types
});
```

Output `ctx.systemPrompt` is designed to be used as the system message in your LLM call.

#### `summarize(options)`

Compresses N old memories into one summary memory using the configured LLM:

```typescript
const { summary, deletedCount } = await ms.memory.summarize({
  actorId: "npc_elena",         // Optional — scope to one actor
  olderThan: new Date("2025-01-01"),  // Optional — only summarize old memories
  skipMostRecent: 5,            // Don't touch the 5 most recent
  targetCount: 15,              // Summarize at most 15 memories
  memoryTypes: ["interaction"], // Only summarize interactions
  keepOriginals: false,         // Delete originals after summary (default false)
});
```

**Warning:** `keepOriginals: false` is data-destructive. The original memories are deleted and replaced with a summary. Set `keepOriginals: true` to preserve originals.

#### `prune(strategy)` / `dryRunPrune(strategy)`

Remove low-value memories:

```typescript
// Prune by age — remove memories older than 30 days
const { pruned, count } = await ms.memory.prune({
  type: "byAge",
  maxAge: 30 * 24 * 60 * 60 * 1000,
});

// Prune by importance — keep only high-importance memories
await ms.memory.prune({ type: "byImportance", minImportance: 0.5 });

// Prune by count — keep at most 500 per actor
await ms.memory.prune({ type: "byCount", maxPerActor: 500 });

// Prune by type — remove all gossip
await ms.memory.prune({ type: "byType", memoryTypes: ["gossip"] });

// Custom predicate
await ms.memory.prune({
  type: "custom",
  predicate: (memory) => memory.content.includes("spam"),
});

// Dry run — see what would be removed without deleting
const { wouldPrune, count } = await ms.memory.dryRunPrune({ type: "byAge", maxAge: 86400000 });
```

#### `count(filter?)`

```typescript
const total = await ms.memory.count();
const interactionsCount = await ms.memory.count({ actorId: "agent_1", memoryType: "interaction" });
```

#### `get(id)` / `delete(id)` / `deleteMany(ids)` / `touch(id)`

```typescript
const mem = await ms.memory.get("mem_abc123");
await ms.memory.delete("mem_abc123");
await ms.memory.deleteMany(["mem_abc", "mem_def"]);  // returns count deleted
await ms.memory.touch("mem_abc");  // bumps recency without changing content
```

---

### Relationship Subsystem

Access via `ms.relationships.*`:

#### `set(actorA, actorB, data)` — upsert

```typescript
const rel = await ms.relationships.set("npc_elena", "player_1", {
  affinity: 20,
  trust: 15,
  fear: 0,
  respect: 10,
  tags: ["rescuer"],
});
```

This is idempotent — calling `set()` again overwrites values. The `interactionCount` increments automatically.

#### `updateDeltas(actorA, actorB, deltas)` — increment/decrement

```typescript
const rel = await ms.relationships.updateDeltas("npc_elena", "player_1", {
  affinity: 5,    // +5 to affinity
  trust: -3,      // -3 to trust
  // only specify what changed
});
```

Throws `NOT_FOUND` if the relationship doesn't exist yet. Use `set()` for first-time creation.

#### `get(actorA, actorB)` / `getAll(actorId)`

```typescript
const rel = await ms.relationships.get("npc_elena", "player_1");
const allElenasRels = await ms.relationships.getAll("npc_elena");
```

#### `find(filter)`

```typescript
const friends = await ms.relationships.find({ minAffinity: 30 });
const enemies = await ms.relationships.find({ maxAffinity: -30 });
const tagged = await ms.relationships.find({ tag: "mentor" });
const byStage = await ms.relationships.find({ stage: "close_friend" });
```

#### `delete(actorA, actorB)`

```typescript
await ms.relationships.delete("npc_elena", "player_1");
```

---

### Quest Subsystem

Access via `ms.quests.*`:

#### `create(def)`

```typescript
const quest = await ms.quests.create({
  title: "Save the Village",
  description: "Defeat the goblin raiders threatening the village.",
  giverId: "npc_elder",
  objectives: [
    { index: 0, description: "Kill 5 goblins", isOptional: false, targetCount: 5 },
    { index: 1, description: "Rescue the captured villagers", isOptional: false },
    { index: 2, description: "Find the goblin leader's treasure", isOptional: true },
  ],
  rewards: {
    gold: 500,
    items: ["Village Hero Sword"],
    relationshipBonus: { "npc_elder": 30 },
  },
  timeLimit: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),  // 7 days
  prerequisites: ["quest_village_intro"],  // Must complete intro first
});
```

#### `accept(id, playerId)`

```typescript
const quest = await ms.quests.accept("quest_abc", "player_1");
// Throws if quest is not "offered" or prerequisites aren't met
```

#### `updateObjective(questId, objIndex, complete)`

```typescript
const quest = await ms.quests.updateObjective("quest_abc", 0, true);
// Status changes to "in_progress" on first objective update
// Auto-completes quest when all non-optional objectives are done
```

#### `complete(id)` / `fail(id)`

```typescript
await ms.quests.complete("quest_abc");
await ms.quests.fail("quest_xyz");
```

#### `list(options?)`

```typescript
const active = await ms.quests.list({ playerId: "player_1", status: ["accepted", "in_progress"] });
const allFromNpc = await ms.quests.list({ giverId: "npc_elder" });
```

#### `get(id)`

```typescript
const quest = await ms.quests.get("quest_abc");
```

---

### Export / Import

Snapshot the full state — all memories, relationships, and quests:

```typescript
const snapshot = await ms.export();
// {
//   version: 1,
//   memories: [...],
//   relationships: [...],
//   quests: [...],
//   exportedAt: "2025-06-06T12:00:00.000Z"
// }

// Save to disk
fs.writeFileSync("state.json", JSON.stringify(snapshot, null, 2));

// Restore later
const data = JSON.parse(fs.readFileSync("state.json", "utf-8"));
const ms2 = new MemStack({ ... });
await ms2.import(data);
```

Use this for:
- Persisting state across server restarts
- Backups before pruning or summarization
- Migrating between storage backends

### Health Checks

```typescript
const status = await ms.health();
if (!status.storage) console.error("Storage is down!");
if (!status.llm) console.error("LLM is unreachable!");
if (!status.embedding) console.error("Embedding service is down!");
```

---

## Configuration

Full `MemStackConfig`:

```typescript
const ms = new MemStack({
  // REQUIRED
  llm: LLMProvider;              // Any LLM adapter — used for summarization

  // OPTIONAL
  embedding?: EmbeddingProvider; // If omitted, semantic search falls back to keyword
  storage?: StorageProvider;     // Default: InMemoryStorage

  defaults?: {
    maxMemoriesPerActor?: number;       // Hard cap, default: no limit
    summarizationThreshold?: number;    // Auto-summarize when interaction count % threshold === 0. Default: 100
    importanceDecayRate?: number;       // How fast importance fades per day. Default: 0.01
    embedOnStore?: boolean;             // Auto-embed memories on store(). Default: true
    pruneStrategy?: PruneStrategy;      // Auto-prune on every process() call. Default: undefined (disabled)
  };

  hooks?: {
    onMemoryStored?: (memory: Memory) => void;
    onMemoryPruned?: (ids: string[]) => void;
    onSummaryCreated?: (summary: Memory, deletedCount: number) => void;
    onRelationshipChanged?: (rel: Relationship) => void;
    onQuestUpdated?: (quest: Quest) => void;
  };
});
```

---

## Advanced Usage

### Custom Storage

Implement the `StorageProvider` interface to use any database:

```typescript
import type { StorageProvider, MemoryStoreInput } from "@memstack/core";
import type { Memory } from "@memstack/core";
import { createClient } from "redis";

class RedisStorage implements StorageProvider {
  private client: ReturnType<typeof createClient>;

  async initialize() {
    this.client = createClient();
    await this.client.connect();
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const memory: Memory = {
      id, actorId: input.actorId, memoryType: input.memoryType ?? "interaction",
      content: input.content, importance: input.importance ?? 0.5,
      emotionalValence: input.emotionalValence ?? 0, tags: input.tags ?? [],
      embedding: input.embedding, sourceId: input.sourceId,
      metadata: input.metadata ?? {}, expiresAt: input.expiresAt,
      createdAt: new Date(),
    };
    await this.client.set(`mem:${id}`, JSON.stringify(memory));
    return memory;
  }

  // ... implement remaining methods
}
```

### Custom LLM Provider

```typescript
import type { LLMProvider } from "@memstack/core";

class TogetherAIAdapter implements LLMProvider {
  constructor(private apiKey: string) {}

  async complete(request: { system: string; user: string; model?: string }) {
    const response = await fetch("https://api.together.xyz/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model ?? "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });
    const data = await response.json() as any;
    return {
      text: data.choices[0].message.content,
      tokens: {
        prompt: data.usage?.prompt_tokens ?? 0,
        completion: data.usage?.completion_tokens ?? 0,
        total: data.usage?.total_tokens ?? 0,
      },
    };
  }
}
```

### Custom Embedding Provider

```typescript
import type { EmbeddingProvider } from "@memstack/core";

class LocalEmbeddingProvider implements EmbeddingProvider {
  dimensions = 384; // mini model

  async embed(texts: string[]): Promise<number[][]> {
    // Use @xenova/transformers or any local embedding library
    const response = await fetch("http://localhost:8080/embed", {
      method: "POST",
      body: JSON.stringify({ texts }),
    });
    return (await response.json()).embeddings;
  }
}
```

### Event Hooks

React to memory lifecycle events:

```typescript
const ms = new MemStack({
  llm: new OpenAILLMAdapter({ apiKey }),
  hooks: {
    onMemoryStored: (memory) => {
      console.log(`New memory: ${memory.id} by ${memory.actorId}`);
    },
    onMemoryPruned: (ids) => {
      console.log(`Pruned ${ids.length} memories: ${ids.join(", ")}`);
    },
    onSummaryCreated: (summary, deletedCount) => {
      console.log(`Summary created (${deletedCount} memories compressed)`);
    },
    onRelationshipChanged: (rel) => {
      console.log(`${rel.actorA} → ${rel.actorB}: ${rel.stage} (affinity: ${rel.affinity})`);
    },
    onQuestUpdated: (quest) => {
      console.log(`Quest "${quest.title}" → ${quest.status}`);
    },
  },
});
```

---

## Memory Lifecycle

### Summarization

Summarization is the process of compressing many old interaction memories into a single summary memory. It uses the configured LLM.

**Auto-summarization** triggers when an actor's interaction count hits a threshold (default: every 100 interactions). Set `summarizationThreshold` in config to customize.

**Manual summarization:**

```typescript
const { summary, deletedCount } = await ms.memory.summarize({
  actorId: "npc_elena",
  olderThan: new Date(Date.now() - 30 * 86400000), // older than 30 days
  skipMostRecent: 10,   // preserve the 10 most recent
  keepOriginals: false, // delete originals after summary
});
```

The default summarization prompt is: *"You are a memory summarizer. Condense the following list of memories into a single, concise summary paragraph..."* You can override this by passing a custom prompt to the `Summarizer` class directly.

### Pruning

Pruning removes low-value memories to keep storage manageable. Run it manually or configure `pruneStrategy` in defaults for auto-pruning on every `process()` call.

```typescript
// Auto-prune: remove memories below 0.1 importance on every process()
const ms = new MemStack({
  llm,
  defaults: {
    pruneStrategy: { type: "byImportance", minImportance: 0.1 },
  },
});
```

### Embeddings

Embeddings enable semantic search — finding memories by meaning, not just keywords.

**With embeddings enabled** (default when embedding adapter is configured): each `store()` call computes an embedding vector. `retrieve()` with `strategy: "semantic"` or `"hybrid"` uses cosine similarity for ranking.

**Without embeddings**: retrieval falls back to keyword matching + importance/recency sorting. This is fine for many use cases and avoids embedding API costs.

**Disable auto-embedding:**

```typescript
const ms = new MemStack({
  llm,
  embedding: new OpenAIEmbeddingAdapter({ apiKey }),
  defaults: { embedOnStore: false },
});
```

Then embed on demand:
```typescript
// Manually embed a batch of memories (for migration or bulk processing)
```

---

## Development

### Setup

```bash
git clone https://github.com/isiomaC/memstack.git
cd memstack
pnpm install
```

### Running Tests

```bash
pnpm test              # Run all tests once
pnpm test:watch        # Watch mode — re-runs on file changes
```

Test files are in `test/`. Tests use the `InMemoryStorage` adapter — no external services required.

**Test coverage:**
- `test/storage.test.ts` — InMemoryStorage CRUD, retrieval strategies, counting
- `test/relationships.test.ts` — Relationship lifecycle, stage computation, filtering
- `test/quests.test.ts` — Quest lifecycle, objectives, prerequisites, statuses
- `test/client.test.ts` — MemStack client, `process()`, `compileContext()`, export/import

### Building

```bash
pnpm build             # tsup: CJS + ESM + DTS
pnpm check             # TypeScript type-check only (no emit)
```

The build produces:
```
dist/
├── index.js           # ESM
├── index.cjs          # CJS
├── index.d.ts         # TypeScript declarations
├── index.d.cts        # CJS declarations
├── index.js.map       # Source maps
└── index.cjs.map
```

### Debugging

**Increase log verbosity:**

MemStack doesn't have built-in logging. Use event hooks for observability:

```typescript
const ms = new MemStack({
  llm,
  hooks: {
    onMemoryStored: (m) => console.debug("[memstack] stored:", m.id, m.content.slice(0, 50)),
    onMemoryPruned: (ids) => console.debug("[memstack] pruned:", ids.length, "memories"),
    onSummaryCreated: (s, n) => console.debug("[memstack] summarized:", n, "→", s.id),
    onRelationshipChanged: (r) => console.debug("[memstack] relationship:", r.actorA, "→", r.actorB, r.stage),
  },
});
```

**Common issues:**

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `CONFIG_ERROR: LLM provider is required` | No LLM adapter passed | Add `llm: new OpenAILLMAdapter({ apiKey })` to config |
| `VALIDATION_ERROR: No memories to summarize` | Not enough memories met the `olderThan` / `targetCount` criteria | Adjust `summarize()` parameters or lower thresholds |
| `NOT_FOUND: Relationship not found` | Tried `updateDeltas()` on a relationship that doesn't exist | Use `set()` for first-time creation, `updateDeltas()` for updates |
| Semantic search returns no results | No embedding adapter configured | Add `embedding: new OpenAIEmbeddingAdapter({ apiKey })` or use `strategy: "recent"` |
| Memory leak / high RAM usage | Using InMemoryStorage in production | Switch to a persistent storage adapter (implement `StorageProvider`) |
| Summarization creates poor quality summaries | Default prompt not suitable for your domain | Override prompt using `Summarizer` constructor or pass custom prompt text |

**Inspecting state:**

```typescript
// Dump all memories to console (dev only — potentially large)
const snapshot = await ms.export();
console.log(`Memories: ${snapshot.memories.length}`);
console.log(`Relationships: ${snapshot.relationships.length}`);
console.log(`Quests: ${snapshot.quests.length}`);

// Inspect one actor's state
const memories = await ms.memory.retrieve({ actorId: "npc_1", limit: 100 });
const rels = await ms.relationships.getAll("npc_1");
console.log(JSON.stringify({ memories, rels }, null, 2));
```

---

## Publishing to npm

```bash
# 1. Bump version in package.json
# 2. Build and verify
pnpm build && pnpm check && pnpm test

# 3. Login to npm (first time only)
npm login

# 4. Publish
npm publish --access public
```

The `@memstack` scope requires `--access public` for the initial publish. Subsequent publishes inherit the access level.

---

## Contributing

Contributions are welcome. Areas that need work:

- **Storage adapters**: Postgres, Redis, SQLite, filesystem (disk)
- **LLM adapters**: Ollama, Groq, Together AI, Gemini
- **Embedding adapters**: Cohere, Voyage AI, local transformers.js
- **More tests**: Edge cases, concurrent access, large-scale performance
- **Docs**: Architecture diagrams, tutorial video, API playground

Open an issue or PR at [github.com/isiomaC/memstack](https://github.com/isiomaC/memstack).

---

## License

MIT © [MemStack](https://github.com/isiomaC/memstack)
