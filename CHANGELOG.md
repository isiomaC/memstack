# Changelog

## v0.4.0

### @memstack/core

#### Breaking changes
- MemoryType: removed `"gossip"`, added `"fact"` and `"reflection"`
- All storage adapters renamed to `*StorageAdapter` suffix (InMemoryStorage → InMemoryStorageAdapter, etc.)
- `MemoryStore.touch()` no longer has delete+re-store fallback — no-op if adapter lacks touch
- Zero peerDependencies — client injection for all drivers (ADR-0001)
- `MemoryStore.export()` and `MemoryStore.stats()` now accept optional `actorId` parameter

#### Production adapters (11, e2e verified against real instances)
- InMemoryStorageAdapter, DiskStorageAdapter, MarkdownStorageAdapter, HybridStorageAdapter — zero deps
- PostgresStorageAdapter — pool-or-connectionString, pgvector, HNSW index
- RedisStorageAdapter — ioredis injection, SMEMBERS actor sets, touch
- QdrantStorageAdapter — UUID point IDs, filtered search
- WeaviateStorageAdapter — v3 client rewrite, nearVector, filter operators
- LanceDBStorageAdapter — embedded columnar, DiskANN native
- MongoDBStorageAdapter — Atlas Vector Search, Community fallback
- Neo4jStorageAdapter — Cypher queries, graphQuery escape hatch, vector index

#### Experimental adapters (7, blocked by cloud deps or platform constraints)
- SQLiteStorageAdapter — better-sqlite3 injection, in-memory cosine (gated on Node 24 native binary)
- ChromaStorageAdapter — embedded vector DB (gated on embedding function dependency)
- PineconeStorageAdapter, UpstashStorageAdapter, Mem0StorageAdapter, ZepStorageAdapter — cloud-only
- TursoStorageAdapter — libsql, DiskANN (cloud-only)

#### Memory pipeline features
- Configurable limits (dedupScan, contextScan, summarizeScan, pruneScan, exportScan, purgeScan)
- O(1) hash index for `onConflict: "append"` dedup
- Custom tokenCounter for ContextCompiler
- Messages format output (`CompiledContext.messages`)
- Configurable important/recent ratio (`contextImportantRatio`)
- Chunked summarization (`chunkSize` config)
- Compose prune strategies
- `purgeActor(actorId)`, `merge(ids)`, `stats()`, `retrieveByTimeRange` (createdAfter/createdBefore), `summarizeStream()`
- `_ensureInit()` lazy initialization for all storage adapters
- Per-actor process count (thread-safe summarization triggers)

#### Testing
- 393 unit tests across 24 test files
- 82 E2E tests across 7 backends (Postgres, Redis, Qdrant, Neo4j, Weaviate, MongoDB, LanceDB)
- `docker-compose.yml` with 6 services
- `e2e/run-all.sh` for automated E2E suite
- `vitest.e2e.config.ts` for isolated E2E test runs

### @memstack/mcp (v0.1.0)
- 12 MCP tools (process, store, retrieve, compileContext, summarize, prune, purgeActor, merge, stats, delete, health, dryRunPrune)
- 2 resources (`memory://{actorId}/context`, `memory://{actorId}/stats`)
- 1 auto-injected prompt (`memory_context`)
- Actor persistence via `MEMSTACK_ACTOR` env var
- Pure env var configuration (MEMSTACK_STORAGE, DATABASE_URL, OPENAI_API_KEY, etc.)
- 15 config + server tests

### @memstack/cli (v0.1.0)
- 12 commands (store, retrieve, context, summarize, prune, purge, merge, stats, delete, health, export, import)
- JSON output to stdout, errors to stderr
- `parseDuration` helper (7d, 24h format)
- `--actor` validation on all actor-scoped commands
- 10 config tests

### @memstack/server (v0.1.0)
- 15 REST endpoints with Hono + Bun
- Bearer token auth (optional via MEMSTACK_API_KEY)
- Rate limiting (configurable via MEMSTACK_RATE_LIMIT)
- Docker multi-stage build (node:22 → bun:1)
- Cloudflare Workers wrangler config
- 9 config tests

### Infrastructure
- pnpm workspace monorepo (4 packages)
- Zero type errors across all packages
- All packages have build + check + test prepublishOnly scripts
- docs/migration/mem0-to-memstack.md
- docs/adr/0001-no-peer-dependencies.md
