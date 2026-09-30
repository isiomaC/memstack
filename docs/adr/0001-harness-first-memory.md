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

### D3. Project identity is derived from the repository, with no stored state

The project ID is recomputed from the repository every time, in this order:

1. a pinned ID in `.memstack.json` at the repository root
   (`memstack project pin <id>`), committed so the team shares it;
2. the first commit on the main line (`git rev-list --max-parents=0
   --first-parent HEAD`), hashed;
3. the normalized `origin` remote, only for shallow clones, whose first
   commit is not available;
4. the shared git directory, for repositories without commits, so
   worktrees still match;
5. the working directory, outside git.

Every clone of a repository has the same first commit, so Claude Code and
Codex started anywhere in it agree, and the ID survives adding or renaming
a remote, moving the folder, new machines, and switching storage. Because
no registry is kept, moving from one store to another (for example
Postgres to SQLite) needs only `memstack export`/`import`: memories carry
their project in `actorId`.

When a more stable source appears, such as a repository's first commit,
memories under the earlier IDs are moved to the new one once, when the
harness server or CLI next starts. The move uses only the storage
contract, so it works on every adapter, and it is safe when two processes
run it at once. `memstack project merge <old-id>` moves memories manually,
for example after pinning.

Trade-offs: a fork shares its first commit with its upstream, so on one
store the two share memory until one is pinned; merging an unrelated
history does not change the ID, because only the first-parent chain is
followed. A stored project registry was rejected because it is state that
can be lost or diverge when switching storage or machines.

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
remember. `memstack connect` registers this profile.

Live testing showed Codex gives MCP server instructions little weight: asked
to "remember" something, it acknowledged it or wrote it into `README.md`
instead of calling `memory_store`. `memstack connect codex` therefore also
adds a short block, between `<!-- memstack:begin -->` and
`<!-- memstack:end -->` markers, to `$CODEX_HOME/AGENTS.md`, which Codex
always loads. With it, Codex saved memories for every phrasing tried. Only
the marked block is ever changed, the file is backed up and written
atomically, reconnecting does not duplicate it, `--dry-run` shows it,
`--no-agents-md` skips it, and `memstack disconnect codex` removes it,
restoring the file exactly. Claude Code follows the MCP instructions, so its
instruction files are not edited.

Verified 2026-09-30 against the official documentation and source:

- Claude Code starts stdio servers in the session's working directory and
  sets `CLAUDE_PROJECT_DIR` to the project root. It also answers
  `roots/list`.
- Codex starts stdio servers in the session's working directory unless the
  server config sets `cwd` (`codex-rs/rmcp-client`, `stdio_server_launcher.rs`).
  It does not advertise roots.
- The harness profile therefore resolves the project from
  `CLAUDE_PROJECT_DIR`, else its working directory, once at startup. A
  Codex session that changes directory mid-session keeps the project it
  started in.
- Claude Code's client runtimes use MCP TypeScript SDK 1.x, and 2.0 for
  protocol revision `2026-07-28`. `@memstack/mcp` uses SDK 1.29, which
  negotiates with both, so no SDK upgrade is needed for Phase 1.

### D7. Harness memory is storage-agnostic

Harness memory works with every supported storage adapter. It depends only
on the existing `StorageProvider` contract, and no feature is tied to one
database.

**Storage drivers are never installed by MemStack.** This is a core design
principle and does not change for harness memory. Users install the driver
for the store they choose (`better-sqlite3`, `pg`, `ioredis`, ...)
themselves, as already documented. No `@memstack/*` package depends on a
driver, and `memstack init`/`connect` never install one. `init` asks which
store to use and prints the install command when the driver is missing.
`doctor` reports a missing driver together with the install command.

`memstack connect` registers the user's own install of `memstack-mcp`
(`npm install -g @memstack/mcp <driver>`) by absolute path, run with the
current Node binary. It does not register an `npx -p <driver>` command,
because npx would download the driver when the harness first starts it.
Before changing any harness config, `connect` starts the server and checks
the MCP handshake, the harness tools, and a storage round trip, so a missing
driver is reported instead of registered. It changes harness config only
through each harness's own `mcp` commands.

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

### D11. Session-start recall through harness hooks (v2)

MCP tools depend on the model choosing to call them. A session-start hook
runs without that choice: `memstack connect` installs one for each harness,
and every new session starts with the project's most important memories.

- `memstack-mcp hook session-start` reads the harness's hook input from
  stdin, resolves the project (from `CLAUDE_PROJECT_DIR`, else the input
  `cwd`), and prints up to 15 memories, at most 6,000 characters, as plain
  text. That stays under Claude Code's 10,000-character and Codex's
  ~2,500-token context limits. Plain stdout is used rather than JSON
  `additionalContext`, which Codex has rejected for `SessionStart`
  (openai/codex#45999). It makes no LLM call, and on any error it prints
  nothing and exits 0, so it never blocks a session.
- Claude Code: `SessionStart` with matcher `startup|resume|clear|compact` in
  `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`),
  since Claude Code has no CLI for hooks. Codex: `SessionStart` with matcher
  `startup|resume` in `$CODEX_HOME/hooks.json`.
- Only MemStack's own entry is added, replaced, or removed. The file's other
  settings and hooks, its indentation, and its trailing newline are kept,
  so `memstack disconnect` restores it byte for byte. A file that is not
  valid JSON is left unchanged. `--no-hooks` skips the hook.
- Codex runs a new or changed hook only after the user approves it with
  `/hooks`. MemStack does not bypass this; `connect` and `doctor` say so.
- Deferred: per-prompt recall (`UserPromptSubmit`), opt-in once session-start
  recall has proven itself, since it adds latency to every prompt; and
  session-end capture, which waits for the Phase 2 decision pipeline and
  deterministic secret filtering.

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
