# MemStack

> The open-source memory layer for AI agents — store, retrieve, summarize, and prune.

[![npm version](https://img.shields.io/npm/v/@memstack/core)](https://www.npmjs.com/package/@memstack/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

```bash
npm install @memstack/core
```

**The problem:** AI agents forget. Every interaction starts from zero. You either stuff everything into the context window (expensive, slow, degrades output quality) or the agent has no memory of past conversations.

**What MemStack does:** A persistent memory pipeline that lives between your agent and the LLM. It stores every interaction, retrieves only what's relevant, summarizes old memories to save tokens, and prunes stale ones automatically. One method call, no infrastructure required.

Think of it as the open-source alternative to [Mem0](https://mem0.ai/) — pluggable storage, bring your own LLM, zero vendor lock-in.

---

## Table of Contents

- [Why MemStack](#why-memstack)
- [Quick Start](#quick-start)
- [The Memory Pipeline](#the-memory-pipeline)
  - [Store](#1-store)
  - [Retrieve](#2-retrieve)
  - [Compile Context](#3-compile-context)
  - [Summarize](#4-summarize)
  - [Prune](#5-prune)
- [Real-World Use Cases](#real-world-use-cases)
  - [Support Agent](#support-agent)
  - [RAG Pipeline](#rag-pipeline)
  - [Multi-User Chatbot](#multi-user-chatbot)
- [Memory Type Reference](#memory-type-reference)
- [Retrieval Strategies](#retrieval-strategies)
- [Embeddings](#embeddings)
- [Adapters](#adapters)
  - [LLM Adapters](#llm-adapters)
  - [Embedding Adapters](#embedding-adapters)
  - [Storage Adapters](#storage-adapters)
- [Full API Reference](#full-api-reference)
  - [MemStack Client](#memstack-client)
  - [Memory Subsystem](#memory-subsystem)
  - [Export / Import](#export-import)
  - [Health & Close](#health-close)
- [Configuration](#configuration)
- [Advanced Usage](#advanced-usage)
  - [Custom Storage](#custom-storage)
  - [Custom LLM / Embedding](#custom-llm-embedding)
  - [Event Hooks](#event-hooks)
- [Development](#development)
  - [Setup & Tests](#setup-tests)
  - [Debugging](#debugging)
- [Publishing to npm](#publishing-to-npm)
- [Contributing](#contributing)
- [License](#license)

---

## Why MemStack

**LLMs have context windows, not memory.** The difference matters.

| Approach | Problem |
|----------|---------|
| **Stuff everything in context** | Cost is O(n²). 100 conversations = thousands of tokens = dollars per call. Quality degrades from "lost in the middle" effect. |
| **Use a vector DB directly** | You get similarity search. You don't get summarization, pruning, recency weighting, deduplication, or token budget management. You're building the pipeline yourself. |
| **Use Mem0** | Proprietary, cloud-only with their hosted API. You don't control where your data lives. |
| **Use MemStack** | Full pipeline. Pluggable everything. Your data, your infrastructure. Open source. |

**What MemStack handles that raw vector DBs don't:**

- **Summarization** — compress 100 old interactions into one paragraph, keep meaning, save tokens
- **Recency weighting** — recent memories matter more; MemStack sorts them higher
- **Importance scoring** — not all memories are equal; high-importance ones survive pruning
- **Deduplication** — identical or near-identical memories are collapsed in context assembly
- **Token budget** — `compileContext()` tells you how many tokens you're spending before the LLM call
- **Memory-type routing** — interactions, summaries, observations treated differently at retrieval time
- **Auto-pruning** — old, low-importance memories clean themselves up

---

## Quick Start

```typescript
import { MemStack, OpenAILLMAdapter, OpenAIEmbeddingAdapter, InMemoryStorageAdapter } from "@memstack/core";

const memstack = new MemStack({
  llm: new OpenAILLMAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
  embedding: new OpenAIEmbeddingAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
  storage: new InMemoryStorageAdapter(),
});

// 1. Store what happened
await memstack.memory.store({
  actorId: "support-bot-42",
  content: "User reports login failing with error 503 on Chrome 125.",
  tags: ["login", "bug", "chrome"],
  importance: 0.8,
});

// 2. Later, retrieve relevant context
const memories = await memstack.memory.retrieve({
  actorId: "support-bot-42",
  query: "login error",
  strategy: "hybrid",
});

// 3. Inject into your LLM call
const ctx = await memstack.memory.compileContext({
  actorId: "support-bot-42",
  maxTokens: 2000,
});

const llmResponse = await llm.complete({
  system: `You are a support bot. Here is what you remember:\n${ctx.systemPrompt}`,
  user: "The user is back and still can't log in. What do you do?",
});

// 4. Every 100 interactions, summarization kicks in automatically.
// Old interactions are compressed into a paragraph. Token costs stay flat.
```

---

## The Memory Pipeline

MemStack's core is a five-stage pipeline. Each stage can be used independently.

### 1. Store

Every agent interaction becomes a `Memory` with metadata that controls how it's retrieved, summarized, and pruned later.

```typescript
interface Memory {
  id: string;
  actorId: string;               // Who this memory belongs to (user ID, agent ID, session ID)
  memoryType: MemoryType;        // "interaction" | "summary" | "observation" | "fact" | "reflection"
  content: string;               // The actual text
  importance: number;            // 0-1 — higher = survives pruning, ranks higher in retrieval
  emotionalValence: number;      // -1 to 1 — for tone-aware retrieval
  tags: string[];                // Filter by tag: "bug", "billing", "urgent", etc.
  embedding?: number[];          // Computed automatically if embedding adapter is configured
  metadata?: Record<string, unknown>;  // Your custom fields
  expiresAt?: Date;              // Auto-pruned after this date
  sourceId?: string;             // Link back to the originating event
  createdAt: Date;
}
```

```typescript
// Simple store
await ms.memory.store({
  actorId: "agent-7",
  content: "Customer asked about refund policy for Q2 purchases.",
  tags: ["billing", "refund"],
});

// Batch store — embeddings are batched into one API call for efficiency
await ms.memory.storeBatch([
  { actorId: "agent-7", content: "First interaction" },
  { actorId: "agent-7", content: "Second interaction" },
  { actorId: "agent-7", content: "Third interaction" },
]);
```

### 2. Retrieve

Pull back what's relevant — by keyword, by meaning (semantic), by recency, or by importance.

```typescript
const memories = await ms.memory.retrieve({
  actorId: "agent-7",              // Scope to one actor
  query: "refund policy",          // What to search for
  strategy: "hybrid",              // How to rank: "recent" | "important" | "semantic" | "hybrid"
  limit: 10,                       // Max results
  memoryTypes: ["interaction"],    // Only certain types
  tags: ["billing"],               // Only certain tags
});
```

**Strategy behavior:**

| Strategy | Sorts by | Requires embeddings | Best for |
|----------|----------|--------------------|----------|
| `recent` | Newest first | No | Knowing what just happened |
| `important` | Highest importance first | No | Filtering noise, keeping signal |
| `semantic` | Cosine similarity to query | Yes | "Find memories about X" |
| `hybrid` | Semantic + importance blend | Yes | Best of both worlds |

No embedding adapter? `semantic` and `hybrid` fall back to keyword matching + importance sort. No API costs, just less precise.

### 3. Compile Context

The killer feature. `compileContext()` takes the retrieval results and assembles an LLM-ready system prompt — deduplicated, sorted by recency and importance, with a token estimate so you know the cost before calling the LLM.

```typescript
const ctx = await ms.memory.compileContext({
  actorId: "agent-7",
  maxTokens: 2000,               // Budget — assembler stops when it hits this
  memoryTypes: ["interaction", "summary"],
});

// ctx.systemPrompt:
// ## Important Memories
// - The customer has been attempting login for 3 days. (importance: 0.85)
// - Refund was processed for order #4521 on Jan 12. (importance: 0.72)
// 
// ## Recent Interactions
// - Customer asked about refund policy for Q2 purchases.
// - Customer reported login error 503 on Chrome 125.

console.log(ctx.tokenEstimate);  // ~280

// Inject into your LLM call
const response = await llm.complete({
  system: ctx.systemPrompt,
  user: userMessage,
});
```

`compileContext()` is the difference between "we have a vector DB" and "we have agent memory." It handles deduplication, token budgeting, and the recent-vs-important split that makes context useful.

### 4. Summarize

When an actor has hundreds of interactions, retrieval gets expensive and context gets bloated. Summarization compresses old interactions into a single paragraph using the configured LLM.

```typescript
const { summary, deletedCount } = await ms.memory.summarize({
  actorId: "agent-7",
  olderThan: new Date(Date.now() - 7 * 86400000),  // Older than 7 days
  skipMostRecent: 10,        // Never touch the 10 most recent
  targetCount: 50,           // Summarize at most 50 memories
  memoryTypes: ["interaction"],
  keepOriginals: false,      // Delete originals after summary
});

// summary.content:
// "Over the past week, the customer reported recurring login failures (error 503)
//  on Chrome 125. Multiple troubleshooting attempts including cache clearing and 
//  password reset were unsuccessful. A refund was processed for order #4521."

console.log(deletedCount);   // 47 — 47 interactions compressed into 1 summary memory
```

**Auto-summarization:** Set `summarizationThreshold` in config (default: 100). Every 100th interaction for an actor triggers summarization automatically.

**Warning:** `keepOriginals: false` deletes the summarized memories. Set `keepOriginals: true` to preserve them alongside the summary.

**Custom summarization prompt:**

```typescript
const ms = new MemStack({
  llm,
  defaults: {
    summarizationPrompt:
      "You are an enterprise support memory compressor. Highlight: customer name,
       product, severity, resolution status, and any open issues.",
  },
});
```

### 5. Prune

Not all memories deserve to live forever. Pruning removes low-value memories to keep storage and retrieval fast.

```typescript
// Remove memories older than 30 days
await ms.memory.prune({ type: "byAge", maxAge: 30 * 86400000 });

// Keep only memories above importance 0.3
await ms.memory.prune({ type: "byImportance", minImportance: 0.3 });

// Keep at most 500 memories per actor
await ms.memory.prune({ type: "byCount", maxPerActor: 500 });

// Remove specific types
await ms.memory.prune({ type: "byType", memoryTypes: ["observation"] });

// Custom logic
await ms.memory.prune({
  type: "custom",
  shouldRemove: (memory) => memory.content.includes("[RESOLVED]"),
});

// Dry run first — see what would be removed
const { wouldPrune, count } = await ms.memory.dryRunPrune({
  type: "byAge",
  maxAge: 86400000,
});
console.log(`Would remove ${count} memories:`, wouldPrune);
```

Auto-prune on every `process()` call by setting `pruneStrategy` in config:

```typescript
const ms = new MemStack({
  llm,
  defaults: {
    pruneStrategy: { type: "byImportance", minImportance: 0.05 },
  },
});
```

---

## Real-World Use Cases

### Support Agent

```typescript
// Every customer message becomes a memory
async function handleMessage(customerId: string, message: string) {
  await ms.memory.store({
    actorId: `customer:${customerId}`,
    content: message,
    importance: detectUrgency(message), // NLP heuristic or LLM call
    tags: classifyIntent(message),      // "billing", "bug", "account", etc.
  });

  // Retrieve everything relevant to this customer's history
  const ctx = await ms.memory.compileContext({
    actorId: `customer:${customerId}`,
    maxTokens: 1500,
  });

  const response = await llm.complete({
    system: `You are a support agent. Customer history:\n${ctx.systemPrompt}`,
    user: message,
  });

  return response.text;
}

// Every 100th interaction, old history auto-compresses.
// A customer with 10,000 messages still fits in a $0.02 LLM call.
```

### RAG Pipeline

```typescript
// Index documents as observation memories
for (const doc of documents) {
  await ms.memory.store({
    actorId: "knowledge-base",
    content: doc.text,
    memoryType: "observation",
    metadata: { source: doc.url, section: doc.section },
  });
}

// Query with semantic search
const relevantDocs = await ms.memory.retrieve({
  actorId: "knowledge-base",
  query: "How does authentication work?",
  strategy: "semantic",
  limit: 5,
});

const ctx = await ms.memory.compileContext({
  actorId: "knowledge-base",
  memoryTypes: ["observation"],
});

// Prompt the LLM with retrieved context
const answer = await llm.complete({
  system: `Answer using only these documents:\n${ctx.systemPrompt}`,
  user: "How does authentication work?",
});
```

### Multi-User Chatbot

```typescript
// Each user gets their own memory space
async function chat(userId: string, message: string) {
  await ms.memory.store({
    actorId: userId,
    content: message,
  });

  const ctx = await ms.memory.compileContext({
    actorId: userId,
    maxTokens: 1000,
  });

  return llm.complete({
    system: `You are a friendly assistant. Conversation history with this user:\n${ctx.systemPrompt}`,
    user: message,
  });
}

// Get stats
const total = await ms.memory.count();
const userCount = await ms.memory.count({ actorId: "user-42" });
```

---

## Memory Type Reference

| Type | Purpose | Example |
|------|---------|---------|
| `interaction` | Default. Direct exchanges between agent and user/other agent. | "User asked about billing." |
| `summary` | Compressed collection of old interactions. Created by `summarize()`. | "Over 3 weeks, user reported 5 login failures..." |
| `observation` | Passive knowledge — facts, documents, things the agent knows but didn't interact with. | "Company refund policy is 30 days from purchase." |
| `fact` | Verified knowledge — discrete truths the agent has confirmed. | "The user's subscription tier is Enterprise." |
| `reflection` | Self-generated insight — the agent thinking about its own experiences. | "I tend to over-explain billing policies — should be more concise." |

Types control retrieval behavior — `compileContext()` treats `interaction` and `summary` differently from `observation`. Use types to separate "what happened" from "what I know."

---

## Retrieval Strategies

Four strategies, each with a purpose:

```typescript
// "What just happened?" — most recent first
await ms.memory.retrieve({ actorId: "x", strategy: "recent", limit: 3 });

// "What matters most?" — highest importance, ignoring age
await ms.memory.retrieve({ actorId: "x", strategy: "important" });

// "What relates to this query?" — cosine similarity search (needs embeddings)
await ms.memory.retrieve({ actorId: "x", query: "login bug", strategy: "semantic" });

// "Balance relevance and importance" — semantic + importance blend
await ms.memory.retrieve({ actorId: "x", query: "login bug", strategy: "hybrid" });
```

**Choosing a strategy:**
- Use `recent` for chatbots, ongoing conversations, anything time-sensitive
- Use `important` for long-running agents where signal-to-noise matters
- Use `semantic` for RAG, document search, knowledge base queries
- Use `hybrid` for most agent memory — it balances meaning with significance

---

## Embeddings

Embeddings power semantic search. They're optional — without them, retrieval uses keyword matching.

**With embeddings** (configure an `EmbeddingProvider`): each `store()` computes a vector. `retrieve()` with `"semantic"` or `"hybrid"` uses cosine similarity ranking.

**Without embeddings**: everything still works — retrieval falls back to importance + recency + keyword filters. No API costs, no setup.

**Batch embedding:** `storeBatch()` sends all texts in one embedding API call, reducing cost and latency.

```typescript
// Disable auto-embedding if you only need keyword search
const ms = new MemStack({
  llm,
  embedding: new OpenAIEmbeddingAdapter({ apiKey }),
  defaults: { embedOnStore: false },
});
```

---

## Adapters

MemStack is provider-agnostic. Every boundary is an interface — bring your own LLM, embedding model, and storage backend.

### LLM Adapters

Used by `summarize()` and `compileContext()`. Ships with OpenAI, Anthropic, Ollama, and Groq built-in — and via `baseURL`, the OpenAI adapter works with **any OpenAI-compatible API** (DeepSeek, Mistral, Gemini, Together AI, Perplexity, Fireworks, xAI, and dozens more).

```typescript
// OpenAI
import { OpenAILLMAdapter } from "@memstack/core";
const llm = new OpenAILLMAdapter({ apiKey: "..." });

// Any OpenAI-compatible API — just change baseURL
const deepseek = new OpenAILLMAdapter({ apiKey: "...", baseURL: "https://api.deepseek.com/v1" });
const mistral = new OpenAILLMAdapter({ apiKey: "...", baseURL: "https://api.mistral.ai/v1" });
const together = new OpenAILLMAdapter({ apiKey: "...", baseURL: "https://api.together.xyz/v1" });

// Anthropic
import { AnthropicLLMAdapter } from "@memstack/core";
const llm = new AnthropicLLMAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  defaultModel: "claude-sonnet-4-5-20250929",
});

// Ollama (built-in)
import { OllamaLLMAdapter } from "@memstack/core";
const llm = new OllamaLLMAdapter({
  baseURL: "http://localhost:11434",
  defaultModel: "llama3.2",
});
```

### Embedding Adapters

Used by semantic retrieval. Ships with OpenAI and Cohere built-in — and via `baseURL`, the OpenAI adapter works with **any OpenAI-compatible embedding API** (Together AI, Voyage AI, Jina, Nomic, and more).

```typescript
import { OpenAIEmbeddingAdapter, CohereEmbeddingAdapter } from "@memstack/core";

// OpenAI
new OpenAIEmbeddingAdapter({ apiKey: "...", model: "text-embedding-3-small" }); // 1536 dims

// Cohere
new CohereEmbeddingAdapter({ apiKey: "..." }); // embed-english-v3.0, 1024 dims

// Any OpenAI-compatible embedding API
new OpenAIEmbeddingAdapter({ apiKey: "...", baseURL: "https://api.voyageai.com/v1", model: "voyage-3" });
```

### Storage Adapters

MemStack ships with **11 production-ready storage adapters (7 experimental)** — every major backend, zero peer dependencies, all client-injected.

### Production (e2e verified against real instances)

**Built-in (zero external deps):**
| Adapter | Backend | Use case |
|---|---|---|
| `InMemoryStorageAdapter` | In-memory Map | Testing, prototyping |
| `DiskStorageAdapter` | Local JSON files | Simple local persistence |
| `MarkdownStorageAdapter` | Append-only .md files | Human-readable, git-diffable, debug-friendly |
| `HybridStorageAdapter` | Compose any two StorageProviders | Cache + durable, edge + durable |

**Relational / SQL:**
| Adapter | Backend | Vector search |
|---|---|---|
| `PostgresStorageAdapter` | PostgreSQL + pgvector | HNSW native |

**Vector databases:**
| Adapter | Backend |
|---|---|
| `QdrantStorageAdapter` | Qdrant |
| `WeaviateStorageAdapter` | Weaviate |
| `LanceDBStorageAdapter` | LanceDB |
| `MongoDBStorageAdapter` | MongoDB Atlas Vector Search |

**Cache / KV:**
| Adapter | Backend |
|---|---|
| `RedisStorageAdapter` | Redis (ioredis) |

**Graph:**
| Adapter | Backend |
|---|---|
| `Neo4jStorageAdapter` | Neo4j |

### Experimental (mock-tested, blocked by cloud deps or platform constraints)

| Adapter | Backend | Blocker |
|---|---|---|
| `SQLiteStorageAdapter` | SQLite (better-sqlite3) | Native binary for Node 24 |
| `TursoStorageAdapter` | Turso (libsql) | Cloud-only (needs Turso account) |
| `ChromaStorageAdapter` | ChromaDB | Embedding function dependency |
| `PineconeStorageAdapter` | Pinecone | Cloud-only (needs API key) |
| `UpstashStorageAdapter` | Upstash Redis + Vector | Cloud-only (needs API key) |
| `Mem0StorageAdapter` | Mem0 OSS or Cloud | Cloud-only (needs API key) |
| `ZepStorageAdapter` | Zep Cloud or CE | Cloud-only (needs API key) |

**Quick-start per backend:**

```ts
// Postgres
import { PostgresStorageAdapter } from "@memstack/core";
const storage = new PostgresStorageAdapter({ connectionString: "postgres://..." });

// Redis
import Redis from "ioredis";
import { RedisStorageAdapter } from "@memstack/core";
const storage = new RedisStorageAdapter({ redis: new Redis() });

// Markdown (append-only, human-readable)
import { MarkdownStorageAdapter } from "@memstack/core";
const storage = new MarkdownStorageAdapter({ dir: "./memories" });

// Hybrid (Redis cache + Postgres durable)
import { HybridStorageAdapter } from "@memstack/core";
const storage = new HybridStorageAdapter({
  cache: new RedisStorageAdapter({ redis: new Redis() }),
  durable: new PostgresStorageAdapter({ connectionString: "postgres://..." }),
});
```

**Custom storage:**
```ts
import type { StorageProvider, MemoryStoreInput } from "@memstack/core";

class MyStorage implements StorageProvider {
  async store(input: MemoryStoreInput): Promise<Memory> { /* ... */ }
  async get(id: string): Promise<Memory | null> { /* ... */ }
  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> { /* ... */ }
  async count(filter?: MemoryCountFilter): Promise<number> { /* ... */ }
  async delete(id: string): Promise<void> { /* ... */ }
  async deleteMany(ids: string[]): Promise<number> { /* ... */ }
  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> { /* ... */ }
  async initialize(): Promise<void> { /* ... */ }
  async close(): Promise<void> { /* ... */ }
}
```

---

## Backend Comparison

| Backend | Vector search | Touch | Status |
|---|---|---|---|
| InMemory | Cosine in-memory | Yes | ✅ Production |
| Disk (JSON) | Keyword + importance | Yes | ✅ Production |
| Markdown | Keyword + importance | No | ✅ Production |
| Postgres | pgvector HNSW | Yes | ✅ Production |
| Redis | RediSearch KNN (auto-detect) | Yes | ✅ Production |
| Qdrant | ANN native | No | ✅ Production |
| Weaviate | BM25 + vector hybrid | No | ✅ Production |
| LanceDB | DiskANN native | No | ✅ Production |
| MongoDB | Atlas Vector Search | No | ✅ Production |
| Neo4j | Neo4j vector index | No | ✅ Production |
| Hybrid | Delegates to cache/durable | If durable supports | ✅ Production |
| SQLite | Cosine in-memory | Yes | ⚠️ Experimental |
| Turso | DiskANN native | Yes | ⚠️ Experimental |
| Chroma | Native | No | ⚠️ Experimental |
| Pinecone | ANN native | No | ⚠️ Experimental |
| Upstash | Native vector (vector mode) | No | ⚠️ Experimental |
| Mem0 | Delegates to Mem0 | No | ⚠️ Experimental |
| Zep | Graphiti temporal graph | No | ⚠️ Experimental |

---

## Full API Reference

### MemStack Client

```typescript
import { MemStack } from "@memstack/core";

const ms = new MemStack({
  llm: LLMProvider,                    // Required — for summarization
  embedding?: EmbeddingProvider,       // Optional — for semantic search
  storage?: StorageProvider,           // Optional — defaults to InMemoryStorageAdapter
  defaults?: {
    summarizationThreshold?: number,   // Auto-summarize every N interactions. Default: 100
    embedOnStore?: boolean,            // Auto-embed on store(). Default: true
    pruneStrategy?: PruneStrategy,     // Auto-prune on every store(). Default: disabled
  },
  hooks?: {
    onMemoryStored?: (memory: Memory) => void;
    onMemoryPruned?: (ids: string[]) => void;
    onSummaryCreated?: (summary: Memory, deletedCount: number) => void;
  },
});
```

### Memory Subsystem

All methods accessible via `ms.memory.*`:

```typescript
// Store
ms.memory.store(input: MemoryStoreInput): Promise<Memory>
ms.memory.storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]>

// Retrieve
ms.memory.retrieve(query: MemoryRetrieveQuery): Promise<Memory[]>
ms.memory.get(id: string): Promise<Memory | null>

// Context assembly
ms.memory.compileContext(options: ContextOptions): Promise<CompiledContext>

// Lifecycle
ms.memory.summarize(options: SummarizeOptions): Promise<{ summary: Memory; deletedCount: number }>
ms.memory.prune(strategy: PruneStrategy): Promise<{ pruned: string[]; count: number }>
ms.memory.dryRunPrune(strategy: PruneStrategy): Promise<{ wouldPrune: string[]; count: number }>

// Management
ms.memory.count(filter?: MemoryCountFilter): Promise<number>
ms.memory.delete(id: string): Promise<void>
ms.memory.deleteMany(ids: string[]): Promise<number>
ms.memory.touch(id: string): Promise<void>  // bump recency without changing content
```

### Export / Import

Snapshot and restore full state for persistence, backups, or migration:

```typescript
// Save
const snapshot = await ms.export();
fs.writeFileSync("state.json", JSON.stringify(snapshot, null, 2));

// Restore
const data = JSON.parse(fs.readFileSync("state.json", "utf-8"));
await ms2.import(data);
```

### Health & Close

```typescript
const status = await ms.health();
// { storage: true, llm: true, embedding: true }

await ms.close(); // graceful shutdown
```

---

## Configuration

```typescript
const ms = new MemStack({
  llm: new OpenAILLMAdapter({ apiKey: "..." }),

  // Defaults control auto-behavior
  defaults: {
    summarizationThreshold: 50,      // Summarize every 50 interactions (default: 100)
    embedOnStore: false,             // Don't auto-embed — saves API costs
    pruneStrategy: {                 // Auto-clean on every store()
      type: "byAge",
      maxAge: 90 * 86400000,         // 90 days
    },
  },

  // Hooks for observability
  hooks: {
    onMemoryStored: (m) => logger.debug("memory:stored", { id: m.id, actor: m.actorId }),
    onMemoryPruned: (ids) => logger.info("memory:pruned", { count: ids.length }),
    onSummaryCreated: (summary, n) => logger.info("memory:summarized", { count: n }),
  },
});
```

---

## Advanced Usage

### Custom Storage

Implement `StorageProvider` for any database. The interface is 9 methods. See the reference section above for the full contract.

### Custom LLM / Embedding

Implement `LLMProvider` or `EmbeddingProvider` for any service:

```typescript
import type { LLMProvider } from "@memstack/core";

class TogetherAIAdapter implements LLMProvider {
  async complete(req: { system: string; user: string; model?: string }) {
    const res = await fetch("https://api.together.xyz/v1/chat/completions", {
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: req.model, messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }] }),
    });
    const data = await res.json() as any;
    return { text: data.choices[0].message.content, tokens: { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens, total: data.usage.total_tokens } };
  }
}
```

### Event Hooks

Monitor memory operations without modifying code:

```typescript
const ms = new MemStack({
  llm,
  hooks: {
    onMemoryStored: (m) => metrics.increment("memory.stored"),
    onSummaryCreated: (_, n) => metrics.gauge("memory.summarized_count", n),
    onMemoryPruned: (ids) => metrics.increment("memory.pruned", ids.length),
  },
});
```

---

---

## Development

### Setup & Tests

```bash
git clone https://github.com/isiomaC/memstack.git
cd memstack
pnpm install

pnpm test           # 393 tests, no external services needed
pnpm test:watch     # Watch mode
pnpm build          # CJS + ESM + type declarations
pnpm check          # TypeScript type-check only
```

### Debugging

Use hooks for observability — MemStack has no built-in logging:

```typescript
const ms = new MemStack({
  llm,
  hooks: {
    onMemoryStored: (m) => console.debug("[memstack] stored:", m.id, m.content.slice(0, 80)),
    onMemoryPruned: (ids) => console.debug("[memstack] pruned:", ids.length),
  },
});
```

**Common issues:**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `CONFIG_ERROR: LLM provider is required` | No LLM adapter | Pass any `LLMProvider` to config |
| Empty retrieval results | Wrong `actorId` or no memories stored | Check `await ms.memory.count({ actorId })` |
| Semantic search not working | No embedding adapter or `embedOnStore: false` | Add embedding adapter or use `strategy: "recent"` |
| High memory usage in production | Using InMemoryStorageAdapter | Implement `StorageProvider` for Postgres/Redis/etc |
| Poor summarization quality | Default prompt doesn't match your domain | Use `summarizationPrompt` in `defaults` config |

**Inspecting state at runtime:**

```typescript
// How much data do we have?
const total = await ms.memory.count();
const perActor = await ms.memory.count({ actorId: "user-42" });

// What does one actor's memory look like?
const snapshot = await ms.export();
const actorMemories = snapshot.memories.filter(m => m.actorId === "user-42");
console.log(`User-42: ${actorMemories.length} memories`);
actorMemories.forEach(m => console.log(`  [${m.memoryType}] ${m.content.slice(0, 60)} (imp: ${m.importance})`));
```

---

## Publishing to npm

```bash
# Bump version, then:
pnpm build && pnpm check && pnpm test
npm login
npm publish --access public
```

The `@memstack` scope requires `--access public` on first publish.

---

## Contributing

Most needed contributions:

- **Docker Compose** for integration testing
- **LLM adapters**: Google Gemini (native), Amazon Bedrock, Vertex AI
- **Embedding adapters**: local inference (transformers.js, ONNX)
- **Benchmarks**: retrieval quality, latency, cost comparisons
- **Python port**: `pip install memstack`

Open an issue or PR at [github.com/isiomaC/memstack](https://github.com/isiomaC/memstack).

---

## License

MIT © [MemStack](https://github.com/isiomaC/memstack)
