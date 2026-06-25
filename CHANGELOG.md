# Changelog

## v0.2.0

### @memstack/core

#### Breaking changes
- MemoryType: removed `"gossip"`, added `"fact"` and `"reflection"`
- All storage adapters renamed to `*StorageAdapter` suffix (InMemoryStorage → InMemoryStorageAdapter, DiskStorage → DiskStorageAdapter, etc.)
- `MemoryStore.touch()` no longer has delete+re-store fallback — no-op if adapter lacks touch
- Removed all peerDependencies — users must provide driver instances (client injection)
- `MemoryStore.export()` and `MemoryStore.stats()` now accept optional `actorId` parameter

#### New adapters (18)
- MarkdownStorageAdapter (append-only .md files, tombstones, vacuum)
- HybridStorageAdapter (write-through cache + durable)
- SQLiteStorageAdapter, TursoStorageAdapter
- Mem0StorageAdapter, ZepStorageAdapter
- QdrantStorageAdapter, PineconeStorageAdapter, ChromaStorageAdapter, WeaviateStorageAdapter, LanceDBStorageAdapter, MongoDBStorageAdapter
- UpstashStorageAdapter (Redis + Vector modes)
- Neo4jStorageAdapter (with graphQuery escape hatch)

#### New memory pipeline features
- Configurable limits (dedupScan, contextScan, summarizeScan, pruneScan, exportScan, purgeScan)
- O(1) hash index for onConflict: "append" dedup
- Custom tokenCounter for ContextCompiler
- Messages format output (CompiledContext.messages)
- Chunked summarization (chunkSize config)
- Compose prune strategies
- purgeActor(actorId), merge(ids), stats(), retrieveByTimeRange (createdAfter/createdBefore), summarizeStream()
- Time range filtering on MemoryRetrieveQuery (createdAfter, createdBefore)

#### Improvements
- PostgresStorageAdapter: pool-or-connectionString, pgvector extension, HNSW index
- RedisStorageAdapter: RediSearch auto-detect removed, simplified
- Configurable retrieve strategy for compileContext
- 334 tests → 393 tests across 24 test files

### @memstack/mcp (v0.1.0)
- MCP server exposing 12 tools, 2 resources, 1 prompt
- Actor persistence via MEMSTACK_ACTOR env var
- Pure env var configuration (MEMSTACK_STORAGE, DATABASE_URL, etc.)
- 13 config tests + 2 server tests

### @memstack/cli (v0.1.0)
- 12 CLI commands: store, retrieve, context, summarize, prune, purge, merge, stats, delete, health, export, import
- JSON output to stdout, errors to stderr
- parseDuration helper for human-readable time strings (7d, 24h)
- 10 config tests

### @memstack/server (v0.1.0)
- REST API with Hono + Bun, 15 endpoints
- Bearer token auth (optional), rate limiting
- Docker multi-stage image, Cloudflare Workers wrangler config
- 9 config tests

### Infrastructure
- pnpm workspace monorepo (4 packages)
- docker-compose.yml for integration testing
- docs/migration/mem0-to-memstack.md
- docs/adr/0001-no-peer-dependencies.md
- PUBLISHING.md
