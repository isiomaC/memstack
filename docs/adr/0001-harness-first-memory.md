# ADR 0001: Map MemStack onto harness-first memory

**Status:** Accepted
**Date:** 2026-09-26 (D7 revised 2026-09-29)

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
need no service other than the configured LLM provider, and memories from
unrelated projects must not leak.

This ADR records how the current `0.7.x` architecture maps onto that
target. Useful existing APIs are kept, and new names are added only where
they improve the Claude Code and Codex integrations.

## Current state (audit of `main` @ 0.7.3)

| Phase 1 requirement | Current MemStack | Gap |
| --- | --- | --- |
| LLM configuration for harness users | `config-env` reads `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` from the environment of each process | No persistent config; harnesses may launch without the user's shell environment |
| Canonical record with provenance | `Memory` has `actorId`, `memoryType`, `content`, `importance`, `tags`, `metadata`, `createdAt` | No `harness`/`sessionId`/`project` provenance and no `updatedAt` |
| Memory kinds | `interaction`, `summary`, `observation`, `fact`, `reflection` | No `preference`, `decision`, or `instruction` |
| Namespaces (global/project/session) | A single free-form `actorId` scopes every operation | No project identity shared across harnesses |
| Search a harness can use | SQLite keeps rows whose content contains the *entire query string* as a substring, after loading every matching row | A natural question such as "what framework do we use?" matches nothing |
| Safe concurrent access from two processes | SQLite uses default journaling and no busy timeout | Claude Code and Codex writing at once can fail with `SQLITE_BUSY` |
| Migrations | `CREATE TABLE IF NOT EXISTS` only | No schema version, so there is no path to add columns or indexes |
| MCP surface | 18 tools, hand-written JSON schemas, `actorId` on each call, SDK `^1.0.0` (1.29 installed) | No project-scoped tool profile, no Zod validation, no bounded output, MCP `2026-07-28` support unverified |
| CLI | Memory operations (`store`, `retrieve`, `prune`, ...) | No `init`, `connect`, `disconnect`, `status`, `doctor`, or `memories` |
| Harness integration | Documented manual MCP configs (`docs/MCP_SETUP.md`) | No `HarnessAdapter`, detection, config merge, verification, or rollback |
| Default store | `MEMSTACK_STORAGE=memory` | Nothing persists by default |

Existing strengths to keep: 17 storage adapters behind one
`StorageProvider` interface, the MCP server over Core, the shared
environment config loader, and the packed-artifact, Docker, and
real-backend verification suite.

## Decisions

### D1. An LLM remains required

MemStack keeps requiring an LLM provider. This deliberately deviates from
the roadmap's "default setup needs no cloud service" and "MemStack works
without AI" gates: MemStack uses the LLM for store-time tagging (D7),
summarization, and merging.

- `memstack init` asks for a provider and API key and verifies them with a
  real request before finishing.
- Any OpenAI-compatible provider works through the existing adapter;
  DeepSeek (`https://api.deepseek.com`, `deepseek-flash`) is verified.
- Recall never calls the LLM (D7), so an LLM outage does not stop recall.
- The existing Ollama adapter can later be exposed in `config-env` as a
  local, no-cloud option.

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

Consequences of reusing `actorId`:

- No storage adapter or schema changes; existing `actor_id` indexes serve
  namespace lookups.
- `global`, `project:`, and `session:` become reserved `actorId` values
  and are documented as such.
- Recalling the project and global namespaces together takes two lookups
  merged in Core, because retrieval filters on one exact `actorId`.
- Sessions of a project cannot be listed by prefix; the session ID is
  provenance in `metadata.source` instead.
- `stats` reports usage per namespace, and purging a namespace forgets a
  whole project.
- A future multi-user requirement ("user X in project Y") would need a
  compound value or, at that point, a dedicated column.

Harness recall returns the project namespace plus `global` by default.

### D3. Project identity is shared by both harnesses

`project-id` is a short hash of, in order of preference:

1. the normalized `origin` remote URL (protocol, credentials, and `.git`
   suffix removed);
2. the absolute path of the git root;
3. the absolute working directory.

Claude Code and Codex started in the same repository resolve to the same
ID. Different clones and worktrees of the same remote share memory, and a
monorepo is one project.

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
`--profile harness` exposes a subset of the existing tools under their
current names:

```text
memory_store  memory_retrieve  memory_get  memory_delete  memory_stats
```

The profile exists for isolation and safety:

- The default tools take an `actorId` that falls back to `default`, and a
  user-scoped harness registration is shared by every repository, so
  memories would leak between projects. Harness tools resolve the project
  namespace from the working directory and do not accept `actorId`.
- Five tools consume less model context than 18 and are easier for the
  model to choose between.
- Destructive or bulk tools (`memory_purge_actor`, `memory_prune`,
  `memory_import`, `memory_delete_many`) are not exposed to autonomous
  agents.

Harness tools validate input with Zod, bound results by count and
characters, and return memory IDs with provenance. The server uses the
MCP `instructions` field to tell the harness when to recall and when to
remember; `memstack connect` does not edit the user's instruction files.
`memstack connect` registers this profile.

Before building it, confirm that Claude Code and Codex start MCP servers
in the project's working directory. If one does not, pass the project
through its supported configuration instead.

Before building this, confirm which MCP protocol versions Claude Code and
Codex support today, and whether the installed SDK negotiates
`2026-07-28`. Upgrade the SDK in its own change if needed.

### D7. Harness memory is storage-agnostic

Harness memory works with every supported storage adapter. It depends only
on the existing `StorageProvider` contract, and no feature is tied to one
database.

**Storage drivers are never installed by MemStack.** This is a core design
principle and does not change for harness memory. Users install the driver
for the store they choose (`better-sqlite3`, `pg`, `ioredis`, ...)
themselves, as already documented. No `@memstack/*` package depends on a
driver, and `memstack init`/`connect` never install one. `init` asks which
store to use and checks that its driver can be loaded. `doctor` reports a
missing driver together with the documented install command.

#### Recall lives in Core

A `LexicalRetriever` in Core serves harness recall in three layers:

1. **Lexical ranking.** Core loads the memories in scope through
   `storage.retrieve()` (no `query`, so adapter-specific text matching is
   not involved). It then ranks them over `content` and `tags`: tokenize,
   drop stopwords, stem, match any term, and score with BM25. The stemmer
   is built in, with no new dependency.
2. **Store-time LLM tags.** Harness writes ask the LLM for 3–5 topic tags
   (the existing `autoTags` behavior), which bridges vocabulary gaps such
   as "framework" versus "Hono". If tagging fails, the memory is still
   stored untagged.
3. **Bounded fallback.** When nothing matches, recall returns the most
   important and recent memories in scope, bounded by count and
   characters.

Candidates are capped (default 2,000 per namespace, most important and
recent first), which comfortably covers one project's memories. Recall
makes no LLM call, so it stays fast, deterministic, and available during a
provider outage. Query-time LLM expansion was rejected because it would
put the LLM on every recall. Embeddings remain an optional Phase 3 layer.

#### Optional adapter capabilities

`StorageProvider` gains optional, additive members; no adapter is required
to change:

- `capabilities?: { multiProcess?: boolean; textSearch?: boolean }`.
- `search?(query)`: native full-text search (for example SQLite FTS5,
  Postgres `tsvector`, or MongoDB `$text`) returning scored memories in
  scope. Core uses it when present and falls back to its own ranking
  otherwise.

Native search is a later performance step for large namespaces, not part
of Phase 1.

#### Concurrent harness processes

Claude Code and Codex are separate processes that share one store. Server
databases (Postgres, Redis, MongoDB, ...) already handle this. File-based
adapters must either make concurrent access safe or declare
`multiProcess: false`, in which case `connect` and `doctor` warn when both
harnesses use them. For SQLite, `initialize()` sets `busy_timeout` (about
5 seconds) and `journal_mode=WAL`, runs multi-row writes in
`BEGIN IMMEDIATE` transactions, and applies numbered migrations. Versions
are tracked per table rather than with `PRAGMA user_version`, so adapters
with different table names can share a file. This is SQLite correctness
that benefits every SQLite user, not harness-specific logic.

#### Proof

A shared harness conformance suite runs against every adapter: namespace
isolation, recall of a natural question ("what framework?" finds "uses
Hono"), updates and deletes, and, where `multiProcess` is declared,
concurrent writes from two processes. It runs against the in-memory,
SQLite, and disk adapters in unit tests and against the server backends
in the Docker end-to-end suite.

This supersedes the earlier plan to add FTS5 search to the SQLite adapter
only. The roadmap's Phase 3 `RetrievalAdapter` grows from
`LexicalRetriever`, and native `search()` implementations plug into it.

### D8. Configuration and secrets

`memstack init` writes `~/.memstack/config.json` holding the provider,
model, base URL, API key, and store path. The file is created with mode
`0600` in a `0700` directory. The MCP server reads it, so Claude Code and
Codex configurations contain no secrets. Environment variables still
override the file.

- The key is never printed, logged, or included in `status`/`doctor`
  output, and `memstack doctor` warns about permissions broader than
  `0600`.
- Any process running as the user, including the harnesses themselves,
  can read the file. Environment variables and harness config files have
  the same exposure, so this is no weaker and keeps one copy of the key.
- OS keychain storage, or storing an environment variable name instead
  of the key, is a later hardening step.

### D9. Claude Code registration is user-scoped

`memstack connect claude-code` registers MemStack once at user scope. The
server derives the project from the working directory (D3, D6), so one
registration serves every repository without writing `.mcp.json` into
them.

### D10. Harness adapters start inside `@memstack/cli`

`HarnessAdapter`, the Claude Code adapter, and the Codex adapter live in
`packages/cli/src/harness/`. Each returns an explicit `ConnectPlan`,
which gives dry-run, preview, backup, atomic writes, and rollback. They
move to their own packages only when a second consumer needs them.
No empty packages are created.

Before implementing either adapter, read the current official Claude Code
and Codex MCP configuration documentation. Record the config file
locations, formats, and scopes the adapter writes in its fixture tests.

### D11. Hooks are a v2 add-on

Phase 1 relies on MCP tools and server instructions only. Harness hooks
are deferred until Phase 1 is stable:

- session-start recall that injects the project's top memories within a
  size budget;
- optional per-prompt recall, at a latency cost on every prompt;
- session-end capture, which depends on the Phase 2 decision pipeline and
  deterministic secret filtering;
- per-harness hook installation, rollback, fixtures, and `doctor` checks.

## Consequences

- Existing `0.7.x` users see no breaking change. The new behavior is
  additive: new memory kinds, an opt-in MCP profile, a config file, and
  new CLI commands.
- Phase 1 changes Core, the SQLite adapter, `config-env`, the MCP server,
  and the CLI. It adds no new package and no storage driver dependency.
- Harness memory works on any supported store; the user picks one and
  installs its driver.
- Every harness user needs an LLM provider key. Recall depends on Core
  lexical ranking and store-time tags, not embeddings or a specific
  database.
- `docs/ROADMAP.md` must list harness memory Phase 1 as the next priority.

## Phase 1 slices

Each slice is independently testable and lands on its own branch:

1. **Storage-agnostic recall:** D7 `LexicalRetriever` in Core, optional
   adapter capabilities, the harness conformance suite, and SQLite
   concurrency fixes (WAL, busy timeout, migrations, transactions) with a
   two-process writer test.
2. **Core model:** D4 memory kinds and D5 provenance, with store-time
   tagging verified against DeepSeek.
3. **Namespaces and config:** D2 and D3 as a project-identity module, and
   D8 config file handling, with fixture tests.
4. **Harness MCP profile:** D6, tested with an MCP client over stdio.
5. **Claude Code adapter:** detect, connect, verify, disconnect, and
   status, with config fixtures.
6. **Codex adapter:** the same, with Codex config fixtures.
7. **CLI:** `init`, `connect`, `disconnect`, `status`, `doctor`, and
   `memories`.
8. **Cross-harness demo:** scripted as far as CI allows without harness
   credentials, then run live in Claude Code and Codex.
