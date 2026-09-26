# ADR 0001: Map MemStack onto harness-first memory

**Status:** Proposed
**Date:** 2026-09-26

## Context

MemStack's next product direction is portable memory shared by agent
harnesses, starting with Claude Code and Codex:

```bash
memstack init
memstack connect claude-code
memstack connect codex
```

The Phase 1 release gate is a cross-harness demo. A memory written in
Claude Code must be recalled in Codex in the same project, and a memory
written in Codex must be recalled in Claude Code. The default setup must
need no cloud service, and memories from unrelated projects must not leak.

This ADR records how the current `0.7.x` architecture maps onto that
target. Useful existing APIs are kept, and new names are added only where
they improve the Claude Code and Codex integrations.

## Current state (audit of `main` @ 0.7.3)

| Phase 1 requirement | Current MemStack | Gap |
| --- | --- | --- |
| Works without AI or a cloud service | `MemStack` throws without an LLM provider, and `config-env` throws unless `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is set | **Blocking.** No offline default |
| Canonical record with provenance | `Memory` has `actorId`, `memoryType`, `content`, `importance`, `tags`, `metadata`, `createdAt` | No `harness`/`sessionId`/`project` provenance and no `updatedAt` |
| Memory kinds | `interaction`, `summary`, `observation`, `fact`, `reflection` | No `preference`, `decision`, or `instruction` |
| Namespaces (global/project/session) | A single free-form `actorId` scopes every operation | No project identity shared across harnesses |
| Search a harness can use | SQLite keeps rows whose content contains the *entire query string* as a substring, after loading every matching row | A natural question such as "what framework do we use?" matches nothing |
| Safe concurrent access from two processes | SQLite uses default journaling and no busy timeout | Claude Code and Codex writing at once can fail with `SQLITE_BUSY` |
| Migrations | `CREATE TABLE IF NOT EXISTS` only | No schema version, so there is no path to add columns or FTS |
| MCP surface | 18 tools, hand-written JSON schemas, `actorId` on each call, SDK `^1.0.0` (1.29 installed) | No harness-oriented `remember`/`recall` tools, no Zod validation, no bounded output, MCP `2026-07-28` support unverified |
| CLI | Memory operations (`store`, `retrieve`, `prune`, ...) | No `init`, `connect`, `disconnect`, `status`, `doctor`, or `memories` |
| Harness integration | Documented manual MCP configs (`docs/MCP_SETUP.md`) | No `HarnessAdapter`, detection, config merge, verification, or rollback |
| Default store | `MEMSTACK_STORAGE=memory` | Nothing persists by default |

Existing strengths to keep: 17 storage adapters behind one
`StorageProvider` interface, the MCP server over Core, the shared
environment config loader, and the packed-artifact, Docker, and
real-backend verification suite.

## Decisions

### D1. LLM becomes optional in Core

`MemStackConfig.llm` becomes optional. Storage, retrieval, `get`,
`delete`, `export`, and `stats` work without it. Operations that need a
model (`summarize`, `merge`, and `process` enrichment) fail with a
structured `LLM_REQUIRED` error. `config-env` stops requiring an API key.

This widens the type, so existing callers keep working.

### D2. Namespace is the existing `actorId`, with a documented format

Every storage adapter already scopes, indexes, and purges by `actorId`.
Adding a separate `namespace` column to all 17 adapters would be churn
without user benefit. Phase 1 instead defines namespace values:

| Namespace | `actorId` value |
| --- | --- |
| Global | `global` |
| Project | `project:<project-id>` |
| Session | `session:<project-id>:<session-id>` |

Harness session IDs are provenance, not the primary namespace. Harness
tools default to the project namespace. Global memory is written only
when a caller explicitly asks for it. Existing free-form `actorId` values
keep working unchanged.

### D3. Project identity is shared by both harnesses

`project-id` is a short hash of, in order of preference:

1. the normalized `origin` remote URL (protocol, credentials, and `.git`
   suffix removed);
2. the absolute path of the git root;
3. the absolute working directory.

Claude Code and Codex started in the same repository resolve to the same
ID. Different clones of the same remote share memory.

### D4. Memory kinds are extended additively

Add `preference`, `decision`, and `instruction` to `MemoryType`. The
roadmap's other kinds map onto existing ones: `episode` onto
`interaction`, and `other` onto `observation`. Project context is a
namespace, not a kind. No existing value is removed or renamed.

### D5. Provenance lives in `metadata.source`

Harness writes set
`metadata.source = { harness, sessionId?, project, cwd? }`. `updatedAt`
is added to `Memory` as optional and is populated by adapters that track
it. Embeddings stay out of the canonical record, as the roadmap requires.

### D6. Harness MCP profile

`memstack-mcp` keeps its 18-tool default profile. A new
`--profile harness` exposes only the roadmap tools:

```text
memory_remember  memory_recall  memory_get  memory_forget  memory_status
```

Harness tools resolve the project namespace from the working directory
and never take a raw `actorId`. They validate input with Zod, bound
results by count and characters, and return memory IDs with provenance.
`memstack connect` registers this profile.

Before building this, confirm which MCP protocol versions Claude Code and
Codex support today, and whether the installed SDK negotiates
`2026-07-28`. Upgrade the SDK in its own change if needed.

### D7. SQLite is the default store, with WAL, migrations, and FTS5

- The default store is `~/.memstack/memstack.db`.
- `initialize()` sets `journal_mode=WAL` and a busy timeout, and applies
  numbered migrations tracked with `PRAGMA user_version`.
- Migration 1 adds an FTS5 index over `content` and `tags`. Queries are
  tokenized and ranked with BM25 instead of whole-string substring
  matching.

The roadmap places FTS in Phase 3. It is pulled forward, for SQLite only,
because the Phase 1 demo cannot pass without word-level search. Phase 3
extracts it into `LexicalRetrievalAdapter`, and other adapters keep their
current search.

`better-sqlite3` stays an optional peer. `memstack connect` registers the
documented form
`npx -y -p @memstack/mcp -p better-sqlite3@^11.10.0 memstack-mcp`.

### D8. Harness adapters start inside `@memstack/cli`

`HarnessAdapter`, the Claude Code adapter, and the Codex adapter live in
`packages/cli/src/harness/`. Each returns an explicit `ConnectPlan`,
which gives dry-run, preview, backup, atomic writes, and rollback. They
move to their own packages only when a second consumer needs them.
No empty packages are created.

Before implementing either adapter, read the current official Claude Code
and Codex MCP configuration documentation. Record the config file
locations, formats, and scopes the adapter writes in its fixture tests.

## Consequences

- Existing `0.7.x` users see no breaking change. The new behavior is
  additive: an optional LLM, new memory kinds, an opt-in MCP profile, and
  new CLI commands.
- The first slice changes Core, the SQLite adapter, `config-env`, the MCP
  server, and the CLI. It adds no new package.
- Without an LLM, `summarize` and `merge` are unavailable. Harness recall
  depends on SQLite FTS, not embeddings.
- `docs/ROADMAP.md` must list harness memory Phase 1 as the next priority.

## Phase 1 slices

Each slice is independently testable and lands on its own branch:

1. **Offline Core:** D1 and D4, plus tests that run with no API key.
2. **SQLite default:** D7 migrations, WAL, and FTS5, plus a
   concurrent-writer test using two processes.
3. **Namespaces and provenance:** D2, D3, and D5 as a project-identity
   module with fixture tests.
4. **Harness MCP profile:** D6, tested with an MCP client over stdio.
5. **Claude Code adapter:** detect, connect, verify, disconnect, and
   status, with config fixtures.
6. **Codex adapter:** the same, with Codex config fixtures.
7. **CLI:** `init`, `connect`, `disconnect`, `status`, `doctor`, and
   `memories`.
8. **Cross-harness demo:** scripted as far as CI allows without harness
   credentials, then run live in Claude Code and Codex.
