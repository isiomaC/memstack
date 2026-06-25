# MemStack — Agent Guide

## Project Overview

`@memstack/core` is an open-source AI memory framework — store, retrieve, summarize, and prune memories for LLM agents and games. It is an npm library (not an application) targeting Node.js >= 18.

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js >= 18 |
| Language | TypeScript 5.7+, strict mode |
| Package manager | pnpm |
| Build | tsup (CJS + ESM + declarations) |
| Test | vitest v1 |
| Type check | `tsc --noEmit` |
| Linter | None configured |

## Commands

```bash
pnpm test          # vitest run — 393 tests, no external services needed
pnpm test:e2e      # 82 E2E tests (requires Docker + docker compose up -d)
pnpm test:watch    # vitest watch mode
pnpm build         # tsup: CJS + ESM + type declarations → dist/
pnpm check         # tsc --noEmit type-check
pnpm dev           # tsup watch mode
pnpm publish       # build + check + npm publish --access public
```

## Verification Workflow (must run after every change)

Every change must pass all three verification tiers. Run them in order:

### Tier 1 — Unit (fast, no external services)
```bash
pnpm check  # zero type errors
pnpm test   # 393 tests must pass
```

### Tier 2 — E2E (requires Docker)
```bash
# Start backends
docker compose up -d postgres redis qdrant neo4j weaviate mongodb

# Wait for all healthy, then:
npx vitest run --config vitest.e2e.config.ts

# Or use the runner:
bash e2e/run-all.sh

# Cleanup:
docker compose down
```

### Tier 3 — Server integration (real requests against running server)
```bash
# 1. Build core first (for Bun import resolution)
npx tsup src/index.ts --format cjs,esm --dts --clean

# 2. Start server with real LLM (DeepSeek) and disk storage
export DEEPSEEK_KEY=$(grep DEEPSEEK_API_KEY .env | cut -d= -f2)
rm -rf /tmp/memstack-server-test && mkdir -p /tmp/memstack-server-test

bun run packages/server/src/index.ts &
SERVER_PID=$!
sleep 2

# 3. Test every endpoint
# Health
curl -s http://localhost:5678/health

# Store
curl -s -X POST http://localhost:5678/v1/memories \
  -H "Content-Type: application/json" \
  -d '{"actorId":"test","content":"integration test","importance":0.9}'

# Retrieve
curl -s -X POST http://localhost:5678/v1/memories/retrieve \
  -H "Content-Type: application/json" \
  -d '{"actorId":"test"}'

# Process (auto-enrich)
curl -s -X POST http://localhost:5678/v1/memories/process \
  -H "Content-Type: application/json" \
  -d '{"actorId":"test","content":"login bug"}'

# Count
curl -s "http://localhost:5678/v1/memories/count?actorId=test"

# Export + Import round-trip
curl -s "http://localhost:5678/v1/memories/export?actorId=test" | \
  curl -s -X POST http://localhost:5678/v1/memories/import \
  -H "Content-Type: application/json" -d @-

# Touch
ID=$(curl -s -X POST http://localhost:5678/v1/memories/retrieve \
  -H "Content-Type: application/json" -d '{"actorId":"test","limit":1}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
curl -s -X POST "http://localhost:5678/v1/memories/$ID/touch"

# 4. Stop server
kill $SERVER_PID
```

### MCP verification (test via JSON-RPC over stdin)
```bash
printf '{"jsonrpc":"2.0","method":"tools/list","id":1}\n' | \
  node packages/mcp/dist/cli.js

# Test tool call
printf '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory_store","arguments":{"actorId":"mcp-test","content":"test"}},"id":2}\n' | \
  node packages/mcp/dist/cli.js
```

### CLI verification (test commands across processes)
```bash
node packages/cli/dist/cli.js store --actor test --content "cli test"
node packages/cli/dist/cli.js retrieve --actor test
node packages/cli/dist/cli.js stats --actor test
```

### Required config for verification

```bash
# DeepSeek (OpenAI-compatible)
export OPENAI_API_KEY=$DEEPSEEK_API_KEY
export MEMSTACK_OPENAI_BASE_URL=https://api.deepseek.com/v1
export MEMSTACK_LLM_MODEL=deepseek-chat
export MEMSTACK_STORAGE=disk
export MEMSTACK_DIR=/tmp/memstack-test
```

### Verification acceptance criteria

- [ ] `pnpm check` — zero type errors
- [ ] `pnpm test` — all 393 pass
- [ ] `pnpm test:e2e` — all 82 pass (Postgres + Redis + Qdrant + Neo4j + Weaviate + MongoDB + LanceDB)
- [ ] Server health check returns `{ "status": "ok" }`
- [ ] Server store → retrieve round-trip works
- [ ] Server count returns correct number
- [ ] Server export → import round-trip preserves data
- [ ] MCP tools/list returns all 12 tools
- [ ] MCP memory_store + memory_retrieve round-trip works
- [ ] CLI store + retrieve across processes works (disk storage)

## Directory Structure

```
src/
├── index.ts                  # Public barrel export (everything users import)
├── client.ts                 # MemStack main client (process, export, import, health, close)
├── interfaces.ts             # All interfaces: providers, config, queries, options
├── types.ts                  # Core types: Memory, CompiledContext, HealthStatus, etc.
├── errors.ts                 # MemStackError class + factory functions
├── memory/
│   ├── MemoryStore.ts        # Core pipeline: store, retrieve, compileContext, summarize, prune
│   ├── ContextCompiler.ts    # Token-budgeted context assembly → systemPrompt
│   ├── Summarizer.ts         # LLM-based summarization
│   └── Pruner.ts             # 5 prune strategies (byAge, byImportance, byCount, byType, custom)
└── adapters/
    ├── llm/
    │   ├── openai.ts         # OpenAI LLM adapter (complete + completeStream)
    │   ├── anthropic.ts      # Anthropic adapter (complete only, no stream)
    │   ├── ollama.ts         # Ollama adapter (complete only, no stream)
    │   └── groq.ts           # Groq adapter (complete + completeStream)
    ├── embedding/
    │   ├── openai.ts         # OpenAI embeddings
    │   └── cohere.ts         # Cohere embeddings
    └── storage/
        ├── memory.ts         # InMemoryStorageAdapter
        ├── disk.ts           # DiskStorageAdapter
        ├── markdown.ts       # MarkdownStorageAdapter
        ├── hybrid.ts         # HybridStorageAdapter
        ├── postgres.ts       # PostgresStorageAdapter
        ├── redis.ts          # RedisStorageAdapter
        ├── sqlite.ts         # SQLiteStorageAdapter
        ├── turso.ts          # TursoStorageAdapter
        ├── mem0.ts           # Mem0StorageAdapter
        ├── zep.ts            # ZepStorageAdapter
        ├── qdrant.ts         # QdrantStorageAdapter
        ├── pinecone.ts       # PineconeStorageAdapter
        ├── chroma.ts         # ChromaStorageAdapter
        ├── weaviate.ts       # WeaviateStorageAdapter
        ├── lancedb.ts        # LanceDBStorageAdapter
        ├── mongodb.ts        # MongoDBStorageAdapter
        ├── upstash.ts        # UpstashStorageAdapter
        └── neo4j.ts          # Neo4jStorageAdapter

test/
├── storage.test.ts           # InMemoryStorageAdapter CRUD (7)
├── client.test.ts            # MemStack client (7)
├── disk-storage.test.ts      # DiskStorageAdapter CRUD (10)
├── new-features.test.ts      # Enrichment, conflict, truncation, touch, prune (32)
├── markdown-storage.test.ts  # MarkdownStorageAdapter (19)
├── hybrid-storage.test.ts    # HybridStorageAdapter (17)
├── sqlite-storage.test.ts    # SQLiteStorageAdapter (25)
├── turso-storage.test.ts     # TursoStorageAdapter (20)
├── mem0-storage.test.ts      # Mem0StorageAdapter (26)
├── zep-storage.test.ts       # ZepStorageAdapter (21)
├── qdrant-storage.test.ts    # QdrantStorageAdapter (22)
├── pinecone-storage.test.ts  # PineconeStorageAdapter (21)
├── chroma-storage.test.ts    # ChromaStorageAdapter (11)
├── weaviate-storage.test.ts  # WeaviateStorageAdapter (24)
├── lancedb-storage.test.ts   # LanceDBStorageAdapter (17)
├── mongodb-storage.test.ts   # MongoDBStorageAdapter (15)
├── upstash-storage.test.ts   # UpstashStorageAdapter (28)
├── postgres-storage.test.ts  # PostgresStorageAdapter (10)
├── redis-storage.test.ts     # RedisStorageAdapter (9)
└── neo4j-storage.test.ts     # Neo4jStorageAdapter (12)
```

## Architecture

### Core Pipeline (5 stages)

1. **Store** — write memory with metadata (importance, tags, embedding)
2. **Retrieve** — query by actorId, strategy (recent/important/semantic/hybrid), tags, types
3. **CompileContext** — assemble LLM-ready system prompt from retrieved memories, token-budgeted
4. **Summarize** — compress N old interactions into 1 summary via LLM
5. **Prune** — remove stale/low-importance memories by strategy

### Key Classes

- **MemStack** (`client.ts`) — public API. Wraps MemoryStore. Handles auto-enrichment (importance scoring, tag extraction), auto-summarization (every N interactions), auto-pruning (every M process() calls).
- **MemoryStore** (`memory/MemoryStore.ts`) — core pipeline coordinator. All 5 stages + touch, export, batch operations.
- **ContextCompiler** (`memory/ContextCompiler.ts`) — splits memories into "important" (importance >= 0.5) and "recent" sets, deduplicates, assembles markdown-formatted prompt within token budget.
- **Summarizer** (`memory/Summarizer.ts`) — calls LLM with formatted memory list, returns compressed paragraph.
- **Pruner** (`memory/Pruner.ts`) — takes memory list + strategy, returns kept memory list. MemoryStore handles the delete.

### Storage Adapter Pattern

All storage adapters implement `StorageProvider` (9 methods: initialize, store, storeBatch, get, delete, deleteMany, touch?, retrieve, count, close). All adapter classes use the `*StorageAdapter` suffix. Each adapter uses client-injection — the user constructs the database driver and passes it in. Zero peer dependencies in package.json.

### IDs

Memory IDs are generated by storage adapters in the format `mem_<random>`. The `MemoryStore.touch()` method is a no-op if the adapter doesn't support `touch`. No delete+re-store fallback.

## Key Documents

- [CONTEXT.md](./CONTEXT.md) — domain glossary (Memory, Actor, StorageProvider, etc.)
- [docs/adr/0001-no-peer-dependencies.md](./docs/adr/0001-no-peer-dependencies.md) — why zero peer deps
- [CHECKLIST.md](./CHECKLIST.md) — implementation tracking

## Conventions

- **No default exports** — always named exports
- **Interfaces over types** for provider contracts (implemented by users)
- **Type aliases** for data shapes (Memory, CompiledContext, etc.)
- **Factory functions** for errors (`notFound()`, `validationError()`, etc.)
- **No runtime dependencies** — all peerDependencies are optional
- **Tests use `as never` casts** for mock LLMs (avoids needing full adapter imports)
- **No comments** unless clarifying non-obvious logic
- **File extensions** — use `.js` in imports (NodeNext/ESM resolution)

## Public API Surface

All public exports flow through `src/index.ts`. Internal classes (MemoryStore, ContextCompiler, Summarizer, Pruner) are **not** exported from the barrel.

## Known Issues

| # | Issue | Location | Severity |
|---|---|---|---|
| 1 | Hardcoded limits in MemoryStore (1000 for dedup scan, 1000 for summarize, 10000 for prune, 100000 for export, 50 for compileContext) | `MemoryStore.ts` | Low |
| 2 | InMemoryStorageAdapter and DiskStorageAdapter sort by importance+recency regardless of strategy (no actual vector search) | `memory.ts`, `disk.ts` | Low |
| 3 | `processCount` starts at 0 — auto-summarization fires on count % threshold === 0, which means the first trigger is at exactly `summarizationThreshold` interactions (correct), but counts from total stored, not per-actor intervals | `client.ts:104` | Low |

## Publishing Checklist

Before publishing a new version:
1. `pnpm check` — must pass (zero type errors)
2. `pnpm test` — must pass (393 tests)
3. `pnpm build` — must produce dist/ with .js, .mjs, .d.ts
4. Verify `dist/index.d.ts` exports all public types
5. Update version in `package.json`
6. `git tag v<version>` after publish
7. All README code examples must be importable from `@memstack/core`

## Version

Current: **0.2.0** (pre-release). 
