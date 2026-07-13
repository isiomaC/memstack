# MemStack Implementation Checklist

> **Test**: `pnpm test` (469) | **E2E**: `pnpm test:e2e` (82) | **Type check**: `pnpm check`

---

## ✅ Complete — v0.2.0 through v0.6.2

### Core (18 storage adapters)
| Adapter | Unit | E2E | Barrel |
|---|---|---|---|
| InMemoryStorageAdapter | 7 | N/A | ✅ |
| DiskStorageAdapter | 10 | N/A | ✅ |
| MarkdownStorageAdapter | 19 | N/A | ✅ |
| HybridStorageAdapter | 17 | N/A | ✅ |
| PostgresStorageAdapter | 10 | 14 | ✅ |
| RedisStorageAdapter | 9 | 10 | ✅ |
| SQLiteStorageAdapter | 25 | — | ❌ exp |
| TursoStorageAdapter | 20 | — | ❌ exp |
| QdrantStorageAdapter | 22 | 8 | ✅ |
| PineconeStorageAdapter | 21 | — | ❌ exp |
| ChromaStorageAdapter | 11 | — | ❌ exp |
| WeaviateStorageAdapter | 24 | 9 | ✅ |
| LanceDBStorageAdapter | 17 | 10 | ✅ |
| MongoDBStorageAdapter | 15 | 14 | ✅ |
| Mem0StorageAdapter | 26 | — | ❌ exp |
| ZepStorageAdapter | 21 | — | ❌ exp |
| UpstashStorageAdapter | 28 | — | ❌ exp |
| Neo4jStorageAdapter | 12 | 11 | ✅ |

### LLM & embedding adapters
| Adapter | Unit | Notes |
|---|---|---|
| OpenAILLMAdapter | 8 | incl. `completeStream` SSE parsing |
| AnthropicLLMAdapter | 5 | mocks `@anthropic-ai/sdk` |
| GroqLLMAdapter | 5 | incl. `completeStream` SSE parsing |
| OllamaLLMAdapter | 5 | no-auth local endpoint |
| OpenAIEmbeddingAdapter | 7 | |
| CohereEmbeddingAdapter | 7 | |

Previously had zero test coverage (request shape, response parsing, and
error/retryable classification were unverified for every real LLM/embedding
provider). Fixed along the way: both OpenAI's and Groq's `completeStream`
silently dropped the final usage-only SSE frame (real providers send total
token counts in a frame with empty `delta.content`), so callers never saw
accurate final token counts — now yielded.

### Memory pipeline
- [x] Configurable limits, O(1) hash index, custom token counter
- [x] Messages format output, chunked summarization, compose prune
- [x] purgeActor, merge, stats, retrieveByTimeRange, summarizeStream

### Distribution packages
- [x] `@memstack/mcp` — 18 tools, 2 resources, 1 prompt, env var config, Streamable HTTP transport
- [x] `@memstack/cli` — 12 commands, JSON output, env var config
  - Integration-tested end-to-end (`packages/cli/test/commands.test.ts`, 18 tests): builds the real CLI binary and spawns it as a subprocess against disk storage and a local mock LLM HTTP server, covering all 12 commands plus their required-flag error paths. Previously only `loadConfig()` was tested.
- [x] `@memstack/server` — 15 REST endpoints, Hono + Bun, Docker + wrangler

### Docs
- [x] CONTEXT.md, AGENTS.md, CHANGELOG.md
- [x] distribution.md, PUBLISHING.md
- [x] ADR: 0001-no-peer-dependencies
- [x] Migration: mem0-to-memstack
- [x] Package READMEs: core, mcp, cli, server
- [x] Skill: `memstack-cli` (`packages/skills/memstack-cli/SKILL.md`)

---

## 🔮 Planned — v1.0

- [ ] `@memstack/relationships` package
- [ ] `@memstack/langchain` package
- [ ] `@memstack/ai-sdk` package
- [ ] E2E: SQLite, Chroma (blocked by platform deps)
- [ ] E2E: Pinecone, Upstash, Mem0, Zep, Turso (cloud-only, needs API keys — unit tests fully mock the SDK/HTTP client, so request shape and auth against the real service remain unverified until credentials are available)
- [ ] Benchmarks vs Mem0
- [ ] Python port

## 🛠 Agent Tasks

- [ ] 3.1 Wire e2e tests into CI
  - Add a CI job that stands up services via GitHub Actions `services:` and runs `pnpm test:e2e`
  - Uncomment experimental adapter exports in `src/index.ts` once a real e2e run passes in CI

- [ ] 3.2 Dedupe CI job preamble
  - Collapse repeated checkout/pnpm-setup/core-build steps across 6 `ci.yml` jobs via a build matrix or shared artifact

- [ ] 3.3 Server production hardening
  - Document or tighten rate-limiter trusted-proxy assumption
  - Use constant-time compare for bearer-token authentication
  - Add correlation/request IDs to at least error responses

- [ ] 3.4 Benchmarks suite
  - Build a benchmark harness comparing retrieval quality (precision/recall) and token-cost curves across adapters and vs Mem0/raw-vector-DB baselines

---

## Totals

| Type | Count |
|---|---|
| Unit tests | 469 |
| E2E tests | 82 |
| Adapters exported | 11 |
| Adapters experimental | 7 |
| Docs | 11 files |
