# MemStack Implementation Checklist

> **Test**: `pnpm test` (393) | **E2E**: `pnpm test:e2e` (82) | **Type check**: `pnpm check`

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

### Memory pipeline
- [x] Configurable limits, O(1) hash index, custom token counter
- [x] Messages format output, chunked summarization, compose prune
- [x] purgeActor, merge, stats, retrieveByTimeRange, summarizeStream

### Distribution packages
- [x] `@memstack/mcp` — 12 tools, 2 resources, 1 prompt, env var config
- [x] `@memstack/cli` — 12 commands, JSON output, env var config
- [x] `@memstack/server` — 15 REST endpoints, Hono + Bun, Docker + wrangler

### Docs
- [x] CONTEXT.md, AGENTS.md, CHANGELOG.md
- [x] distribution.md, PUBLISHING.md
- [x] ADR: 0001-no-peer-dependencies
- [x] Migration: mem0-to-memstack
- [x] Package READMEs: core, mcp, cli

---

## 🔮 Planned — v1.0

- [ ] `@memstack/relationships` package
- [ ] `@memstack/langchain` package
- [ ] `@memstack/ai-sdk` package
- [ ] `@memstack/server` README
- [ ] E2E: SQLite, Chroma (blocked by platform deps)
- [ ] E2E: Pinecone, Upstash, Mem0, Zep, Turso (cloud-only, needs API keys)
- [ ] Benchmarks vs Mem0
- [ ] Python port
- [ ] **Skill: `memstack-cli`** — teach LLMs to use `@memstack/cli` for persistent agent memory
  - [ ] Write `packages/skills/memstack-cli/SKILL.md`
    - [ ] Section: What MemStack is and when to use it (2-3 sentences)
    - [ ] Section: Installation (`npm install -g @memstack/cli`, `npx`, verify with `health`)
    - [ ] Section: Configuration — all 8 env vars (`MEMSTACK_STORAGE`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MEMSTACK_OPENAI_BASE_URL`, `MEMSTACK_LLM_MODEL`, `MEMSTACK_DIR`, `DATABASE_URL`, `SQLITE_PATH`, `REDIS_URL`, `MEMSTACK_EMBED_ON_STORE`), their defaults, and storage backend options (memory, disk, markdown, postgres, sqlite, redis)
    - [ ] Section: Command reference — all 12 commands with required/optional flags, valid values, example invocations, and JSON output schema
      - `store`, `retrieve`, `context`, `summarize`, `prune`, `purge`, `merge`, `stats`, `delete`, `health`, `export`, `import`
    - [ ] Section: Integration pattern — the memory loop: retrieve context before turn → respond → store interaction after turn. Periodic maintenance: summarize old, prune stale.
    - [ ] Section: Best practices — when to use each command, importance scoring guidance (0.0–1.0), token budget management, actor ID conventions (per-agent, per-session, per-user), storage backend choice tradeoffs
  - [ ] Verify: run `pnpm check && pnpm test` in the CLI package
  - [ ] File location: `packages/skills/memstack-cli/SKILL.md` (following pattern from distribution.md § OpenAI Skills Manifest)

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
| Unit tests | 393 |
| E2E tests | 82 |
| Adapters exported | 11 |
| Adapters experimental | 7 |
| Docs | 11 files |
