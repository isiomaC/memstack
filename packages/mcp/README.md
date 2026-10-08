# @memstack/mcp

MCP server for MemStack — persistent AI agent memory via the Model Context Protocol. Includes a harness profile that gives Claude Code and Codex one shared memory per project.

## Installation

```bash
npm install -g @memstack/mcp
```

Install a database driver only when selecting that storage backend:

```bash
npm install @memstack/mcp better-sqlite3@^11.10.0 # SQLite
npm install @memstack/mcp ioredis@^5.11.1         # Redis
npm install @memstack/mcp postgres@^3.4.9         # Postgres (or pg)
```

With `npx`, add the driver with `-p` and name the command, for example
`npx -y -p @memstack/mcp -p postgres@^3.4.9 memstack-mcp`. Copy-paste client
configs for each backend are in
[MCP Setup: Database backends](../../docs/MCP_SETUP.md#database-backends-sqlite-postgres-redis).

Memory, disk, and Markdown storage need only `@memstack/mcp`. SQLite requires
a writable database path and package lifecycle scripts. The Glama deployment
image is `packages/mcp/Dockerfile`; it runs the stdio MCP command directly,
which Glama wraps as its hosted transport. It is not the REST server image.

## Quick Start

Add to your MCP client config (`~/.config/opencode/`, `~/.claude/mcp.json`, or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "memstack": {
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Harness profile (Claude Code and Codex)

`memstack-mcp --profile harness` is a smaller, project-scoped server for
coding agents. You normally don't configure it by hand:
[`memstack connect`](../cli/README.md#claude-code-and-codex) registers it with
Claude Code and Codex.

```bash
npm install -g @memstack/cli @memstack/mcp better-sqlite3@^11.10.0
memstack init && memstack connect claude-code && memstack connect codex
```

| Tool | Description |
|---|---|
| `memory_store` | Save a fact, decision, preference, or rule to project memory (`scope: "global"` for every project) |
| `memory_retrieve` | Recall memories for a natural-language question; local keyword ranking, no LLM call |
| `memory_get` | Get one memory by ID |
| `memory_delete` | Delete a wrong or outdated memory |
| `memory_stats` | Show the current project and its memory count |

- **No `actorId`.** The project comes from `CLAUDE_PROJECT_DIR` (set by
  Claude Code) or the working directory (Codex), identified by the
  repository's first commit. One project can't read or delete another's
  memories, and bulk or destructive tools are not exposed.
- **Instructions.** The server sends MCP `instructions` telling the agent to
  recall at the start of a task and to save when asked to remember.
- **Tagging.** `memory_store` asks your LLM for topic tags so category
  questions find specific memories; if tagging fails, the memory is still
  saved.
- **Settings** come from `~/.memstack/config.json` (written by
  `memstack init`) overlaid with the environment variables below. Stdio only.
- **`--harness <name>`** labels which agent wrote each memory.

### Session-start hook

`memstack-mcp hook session-start` prints the project's most important memories
(up to 15, at most 6,000 characters) as plain text. `memstack connect`
installs it as a `SessionStart` hook in Claude Code and Codex, so each new
session starts with them. It reads the harness's hook input from stdin, makes
no LLM call, and on any error prints nothing and exits 0, so it never blocks
a session.

## Configuration

The default profile is configured by environment variables only. The harness
profile also reads `~/.memstack/config.json`; any LLM variable in the
environment replaces the file's `llm` section, and `MEMSTACK_STORAGE` replaces
its `storage` section.

### Storage backends

| Variable | Values | Default |
|---|---|---|
| `MEMSTACK_STORAGE` | memory, disk, markdown, postgres, sqlite, redis | `memory` |

**In-memory (default — testing only, data lost on restart):**
```
MEMSTACK_STORAGE=memory
```

**Disk (JSON file per actor):**
```
MEMSTACK_STORAGE=disk
MEMSTACK_DIR=/Users/me/.memstack
```

**Markdown (zero infra, human-readable):**
```
MEMSTACK_STORAGE=markdown
MEMSTACK_DIR=/Users/me/.memstack
```

**Postgres (production):**
```
MEMSTACK_STORAGE=postgres
DATABASE_URL=postgresql://user:pass@localhost/memstack
```

**Redis:**
```
MEMSTACK_STORAGE=redis
REDIS_URL=redis://localhost:6379
```

**SQLite:**
```
MEMSTACK_STORAGE=sqlite
SQLITE_PATH=./memory.db
```

### LLM providers

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI LLM (default) |
| `ANTHROPIC_API_KEY` | Anthropic (summarization) |
| `MEMSTACK_OPENAI_BASE_URL` | Custom API endpoint (DeepSeek, etc.) |
| `MEMSTACK_LLM_MODEL` | Model override |
| `MEMSTACK_EMBED_ON_STORE` | Auto-embed on store (default: true) |
| `MEMSTACK_ACTOR` | Default actor ID |

At least one of `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` must be set. Anthropic preferred if both are set. The one exception is `--profile harness`, which starts without a key and saves memories without topic tags; recall never uses the key.

### Embeddings (semantic search)

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI embeddings |

Without embedding config, retrieval falls back to keyword + importance search.

## Tools

The default profile exposes these tools to the agent:

| Tool | Description |
|---|---|
| `memory_process` | Store with auto-enrichment (importance, tags) |
| `memory_store` | Store a memory |
| `memory_store_batch` | Store multiple memories in one call (batched embeddings) |
| `memory_get` | Get a single memory by ID |
| `memory_retrieve` | Retrieve memories by query, strategy, time range |
| `memory_compile_context` | Assemble token-budgeted LLM-ready context |
| `memory_summarize` | Compress old interactions via LLM |
| `memory_prune` | Remove stale/low-importance memories |
| `memory_purge_actor` | Delete all memories for an actor |
| `memory_merge` | Merge multiple memories into one |
| `memory_stats` | Memory diagnostics (counts, types, importance) |
| `memory_delete` | Delete a single memory |
| `memory_delete_many` | Delete multiple memories by ID |
| `memory_touch` | Bump a memory's recency without changing its content |
| `memory_export` | Export a memory snapshot for backup/migration |
| `memory_import` | Import memories from a snapshot produced by `memory_export` |
| `memory_health` | Check storage/LLM/embedding connectivity |
| `memory_dry_run_prune` | Preview what would be pruned |

## Resources

| URI | Description |
|---|---|
| `memory://{actorId}/context` | Compiled LLM context as markdown |
| `memory://{actorId}/stats` | Actor memory stats as JSON |

## Input handling

Tool arguments are normalized and validated before storage:

- `memory_store` / `memory_process` reject an empty or missing `content` with a tool error instead of creating a blank memory.
- Non-string `content` is coerced to a string; `importance` is clamped to `0.0–1.0`; empty tags are dropped; `actorId` is trimmed.
- `memory_import` with an empty `memories` array returns `{ "imported": 0 }` (flagged `isError`) instead of throwing.
- `memory_import` preserves each memory's original `createdAt`, so it round-trips exactly with `memory_export`.
- `memory_prune` / `memory_dry_run_prune` reject unknown strategy `type` values with a clear error.

## Prompts

| Prompt | Description |
|---|---|
| `memory_context` | Auto-injected memory context for current actor |

## Transport

By default `memstack-mcp` speaks MCP over **stdio** — the client spawns it as a subprocess (the Quick Start config above). This is the right choice for one agent per process (opencode, Claude Code, Claude Desktop, Cursor, etc.).

For a shared memory server reachable by multiple agents/processes over the network, run it in **Streamable HTTP** mode instead:

```bash
memstack-mcp --http --port 3939
# MCP endpoint: http://localhost:3939/mcp
```

HTTP mode binds to `127.0.0.1` by default, so only this machine can connect, and it has **no authentication**. `--host <address>` changes the bind address (for example `--host 0.0.0.0` inside a container); a non-loopback address prints a warning, because anyone who can reach the port can read and write memory. Put it behind a proxy that authenticates before exposing it. The harness profile (`--profile harness`) is stdio only.

HTTP mode is stateless (`sessionIdGenerator: undefined` per the MCP spec) — each request gets a fresh protocol handshake, but all requests share one underlying MemStack instance, so storage connections aren't reopened per call. Point any Streamable-HTTP-capable MCP client at `http://host:3939/mcp`.

## Actor persistence

In the default profile, all memories belong to the `"default"` actor by default. Set `MEMSTACK_ACTOR` to identify the agent:

```
MEMSTACK_ACTOR=my-agent
```

This keeps memory isolated per agent. The agent can also override the actor with `actorId` in any tool call.

## Publishing

```bash
cd packages/mcp
pnpm build && pnpm check && pnpm test
npm publish --access public
```

After publishing, users install with:

```bash
npm install -g @memstack/mcp
```

## License

MIT
