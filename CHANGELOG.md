# Changelog

## v0.8.4

### @memstack/core

- Secret filter. `HarnessMemory.remember` now refuses a memory that contains a
  credential (private keys, AWS, GitHub, Slack, Stripe, Anthropic, OpenAI,
  Google and npm tokens, JWTs, bearer tokens, passwords in connection strings,
  and `password = "..."` style assignments) and names the kind without
  repeating the value. It runs before the LLM is asked for tags, so a secret
  never reaches the provider, and it also checks tags. The new `secretPolicy`
  option takes `reject` (default), `redact`, or `off`. `scanSecrets`,
  `redactSecrets` and `filterSecrets` are exported. The check is pattern-based
  and will miss formats it doesn't know.

### @memstack/mcp

- `memstack-mcp --http` now listens on `127.0.0.1` instead of every network
  interface. It has no authentication, so `--host <address>` is needed to
  expose it, and a non-loopback address prints a warning. The startup message
  now shows the real address.
- `MEMSTACK_SECRET_POLICY` (`reject`, `redact`, `off`) sets the harness
  profile's secret policy; the default `reject` makes `memory_store` fail with
  a message for a memory that contains a credential.

- The harness tools ignore unknown arguments instead of failing the call, and
  their reply names what was ignored. Models sometimes add fields such as
  `project_id`: Codex's first `memory_retrieve` failed with
  `Unrecognized key: "project_id"` and had to retry. Unknown arguments still
  can't choose the project, which always comes from the working directory.

### Docs

- The README opens with the Claude Code and Codex demo and the harness setup.

## v0.8.1

### @memstack/cli

- `memstack <command> --help` (or `-h`, or `memstack help <command>`) prints
  each command's flags, and `memstack --version` prints the installed version.
  Before, every command rejected `--help`, though the usage text pointed to it.
- The memory commands (`store`, `retrieve`, `context`, and the rest) now read
  `~/.memstack/config.json`, overlaid with environment variables as the harness
  commands already were. Before, they read only environment variables, so they
  failed after `memstack init` with no variables set. If you rely on the
  default in-memory store while a config file exists, set
  `MEMSTACK_STORAGE=memory`.
- `--project` replaces `--actor` with the current repository's project, so
  memories stored from the shell are the ones Claude Code, Codex, and
  `memstack memories` see.
- `memstack status` reports configuration that comes from environment
  variables. Before, it said "Config: none" even when variables configured
  everything, and agents took that to mean MemStack wasn't set up.
  `memstack doctor` no longer warns about a missing config file in that case.
- An unknown command says so before checking the configuration, instead of
  failing on a missing API key.

- The `memstack connect codex` guidance in `~/.codex/AGENTS.md` now tells
  Codex to check `memory_retrieve` at the start of a task, not only before
  answering questions. Asked to "add a deploy script", Codex had asked which
  platform to use instead of recalling it. Run `memstack connect codex` again
  to update the block; `memstack doctor` reports it as outdated until then.

### Agent skill

- Inside Claude Code or Codex, the `memstack-cli` skill now sends the agent to
  `memstack connect` and the `memory_store` and `memory_retrieve` tools, and
  to `--project` for any shell use. Agents had invented their own actor IDs,
  which the other harness never saw, and shell writes fail in Codex's default
  sandbox when the store is outside the workspace.

### Other packages

- `@memstack/core`, `@memstack/config-env`, `@memstack/mcp`, and
  `@memstack/server` have no changes; they move to 0.8.1 so all packages share
  one version.

## v0.8.0

Persistent memory shared by Claude Code and Codex: what you tell one agent,
the other recalls in the same project.

```bash
npm install -g @memstack/cli @memstack/mcp better-sqlite3@^11.10.0
memstack init
memstack connect claude-code
memstack connect codex
```

MemStack still never installs storage drivers; any supported store works.

### @memstack/cli

- `memstack init` chooses an LLM provider and store, verifies the key with a
  real request, and writes `~/.memstack/config.json` with owner-only
  permissions. The key comes from a hidden prompt or `--api-key-env <VAR>`,
  never a command-line argument.
- `memstack connect claude-code|codex` registers your installed
  `memstack-mcp` through each harness's own `mcp` commands. It checks the
  server before changing anything, confirms the harness reads the new entry,
  undoes every change if a later step fails, and changes nothing when already
  connected. `--dry-run` shows the changes. `memstack disconnect` reverses
  it and keeps your memories.
- `connect` installs a session-start hook for Claude Code
  (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`) that loads
  the project's most important memories into every new session, with no LLM
  call. Codex runs it after you approve it once with `/hooks`. `--no-hooks`
  skips it.
- For Codex, `connect` also adds a marked MemStack block to
  `~/.codex/AGENTS.md` so Codex saves memories when asked. `--no-agents-md`
  skips it.
- `disconnect` removes the hook and the block, restoring each file byte for
  byte. Files are backed up before every change.
- `memstack status`, `memstack doctor` (`--live` tests the LLM key),
  `memstack memories [query] [--delete <id>]`, and `memstack project`
  (`pin <id>`, `merge <old-id>`).
- Nothing is installed for you: when `memstack-mcp` or a storage driver is
  missing, the commands print the `npm install -g` command to run.

### @memstack/mcp

- `memstack-mcp --profile harness [--harness <name>]` serves five
  project-scoped tools (`memory_store`, `memory_retrieve`, `memory_get`,
  `memory_delete`, `memory_stats`) with Zod-validated input, bounded output,
  and MCP server instructions. The project comes from `CLAUDE_PROJECT_DIR` or
  the working directory; settings come from `~/.memstack/config.json` plus
  environment variables. The default 18-tool profile is unchanged.
- `memstack-mcp hook session-start` prints the session-start context. It
  never blocks a session: on any error it prints nothing and exits 0.
- Project IDs come from the repository with no stored state: a pinned ID in
  `.memstack.json`, else the first commit, else (shallow clones) the `origin`
  remote, else the git directory or folder. Clones, worktrees, remote
  changes, moved folders, and storage switches keep the same ID, and
  memories stored before a repository's first commit are adopted
  automatically.

### @memstack/core

- `LexicalRetriever` recalls memories across several actors with BM25
  ranking, stemming, and prefix matching over content and tags, plus a
  bounded most-important fallback. It works on every storage adapter, needs
  no embeddings, and makes no LLM call.
- `HarnessMemory` provides remember, recall, get, forget, and stats for agent
  harnesses on any storage adapter. Writes record `metadata.source`
  provenance and ask the LLM for topic tags, storing the memory untagged if
  tagging fails or times out. Reads and deletes are limited to the caller's
  namespaces, and recall never calls the LLM. `moveNamespace()` and
  `adoptProjects()` move memories between namespaces, safely when two
  processes run at once.
- Memory types `preference`, `decision`, and `instruction`, accepted by Core,
  the REST server, and the MCP server.
- Harness namespace helpers: `GLOBAL_NAMESPACE`, `projectNamespace()`,
  `sessionNamespace()`, and `defaultRecallNamespaces()`. `global`,
  `project:`, and `session:` are now reserved `actorId` values.
- Optional `StorageProvider` members: `capabilities` (`multiProcess`,
  `textSearch`) and a native `search()` hook. Existing adapters need no
  changes. `multiProcess` is declared, and verified by two-process
  end-to-end tests, for SQLite, Postgres, Redis, and MongoDB.
- `retrieve({ touch: false })` reads without marking memories as accessed.
  Honored by the memory, disk, SQLite, Postgres, Redis, and Turso adapters,
  which previously always touched.
- SQLite: `initialize()` sets `busy_timeout` (default 5000 ms,
  `busyTimeoutMs`) and WAL mode (`walMode`), so concurrent processes wait
  instead of failing with `SQLITE_BUSY`. Schema changes are numbered
  migrations tracked per table in `memstack_schema_migrations`; existing
  databases are adopted unchanged. `storeBatch()` is atomic.

### Fixes

- Postgres: `initialize()` no longer fails with a duplicate key in `pg_type`
  when two processes start at once on a new database.
- MongoDB: `store()` with an existing `id` now updates the memory, keeping its
  actor, type, and creation time, as the other adapters do, instead of
  failing with a duplicate key error.
- Auto-importance and auto-tagging no longer return empty results with
  reasoning models such as `deepseek-flash`, whose thinking used up the old
  10–100 token caps. Enrichment calls now allow up to 1024 tokens.
- A SQLite or Redis error other than a missing driver is reported as is,
  instead of as "install the driver".
- The DeepSeek example uses `deepseek-flash`; `deepseek-chat` is no longer
  accepted by the DeepSeek API.

### Release checks

- `server.json` (MCP Registry metadata) is now included in the version
  consistency check, so it cannot drift from the npm packages again.

## v0.7.3

### @memstack/mcp

#### Distribution and runtime
- Externalized SQLite and Redis storage drivers behind explicit optional peer
  contracts, so packed MCP consumers install only the storage runtime they use.
- Added a Node 22 stdio MCP Docker image and a CI smoke gate for the
  Glama-targeted runtime.
- Added packed-consumer SQLite MCP store/retrieve verification and documented
  storage-specific installation requirements.

### Infrastructure
- The release verification suite now covers the MCP image separately from the
  REST server image.

## v0.7.0

### @memstack/core

#### New features
- `createdAt?: Date` added to `MemoryStoreInput` — all 18 storage adapters now
  honor a caller-supplied `createdAt`. When omitted, adapters default to the
  current time. `MemStack.import()` coerces string dates so `export` → `import`
  is a lossless round-trip (safe for backups and cross-backend migration).
- `actorId?: string` added to `PruneStrategy` — prune/dryRunPrune now scope
  their memory scan to the given actor instead of scanning all actors. Fixes a
  bug where pruning one actor would delete another actor's memories.
- Keyword retrieval now tokenizes multi-word queries (OR over terms) in the
  built-in adapters (InMemory, Disk, Markdown). Previously a whole-phrase
  substring match, which made queries like `"login error"` return zero results
  for content like "login failing with error...".

#### Bug fixes
- `MemStack.import()` coerces string `createdAt` and `expiresAt` to `Date` so
  the core, server, and MCP import paths all produce valid `Memory` objects.
- AnthropicLLMAdapter now throws an actionable, non-retryable error when
  `@anthropic-ai/sdk` is not installed (was: raw `ERR_MODULE_NOT_FOUND`).

#### Infrastructure
- Changed `zod` from `^4.0.0` to `^3.23.8` (v4 has no stable release on npm).
  Server OpenAPI generation now uses `zod-to-json-schema`.

### @memstack/cli

#### Behaviour changes
- `--importance` is clamped to 0.0–1.0 (out-of-range values were silently
  accepted before).
- `--actor` is trimmed of leading/trailing whitespace.
- `--tags` drops empty entries from trailing/double commas.
- `prune --type` rejects unknown strategy names with a non-zero exit instead of
  silently doing nothing.
- `import` rejects empty snapshots with a clean error; `createdAt` is preserved
  on imported memories.

### @memstack/mcp

#### Validation hardening
- `memory_store` / `memory_process` reject empty or missing `content` with a
  tool error (was: silently created a garbage memory with `actorId: "default"`).
- Non-string `content` is coerced to a string; `importance` is clamped to
  0.0–1.0; empty tags are dropped; `actorId` is trimmed.
- `memory_import` guards against empty or missing `memories` arrays (was: raw
  `TypeError` crash).
- `memory_prune` / `memory_dry_run_prune` reject unknown strategy `type` values
  with a clear error (was: silently returned zero results).

#### Tests
- HTTP transport test replaced a fixed 1500 ms sleep with a readiness poll
  (flaky `ECONNREFUSED` under parallel suite runs).

### @memstack/server

#### Fixes
- `parseBody` made generic (`S extends z.ZodTypeAny`) to satisfy zod v3's
  stricter `.transform()` input/output variance typing. Fixes the server DTS
  build in CI.
- Docker tag corrected from `:v0.6.4` to `:0.6.4` in README (published tag has
  no `v` prefix).

### Docs
- Corrected auto-summarize/prune semantics in README (they run inside
  `process()`, not `store()`; prune is throttled by `pruneInterval`).
- Documented previously-undocumented config options: `pruneInterval`,
  `autoImportance`, `autoTags`, `summarizationPrompt`, `onError` hook.
- Internal docs moved to `docs/internal/` (gitignored). `docs/` now tracked
  only for user-facing documents (`MCP_SETUP.md`).
- Added comprehensive manual QA runbook (`docs/internal/e2e-plan.md`),
  run once live (473 unit tests, 66 docker-backed e2e tests, all surfaces
  green). QA artifacts at `docs/qa/`.

### CI
- Publish workflow now builds `config-env` before `pnpm publish -r` (CLI/MCP/
  server prepublishOnly tests require the built module).
- Disk storage concurrency fixed with cross-process file locking.

---

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
