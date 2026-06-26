# @memstack/mcp

MCP server for MemStack — persistent AI agent memory via the Model Context Protocol.

## Installation

```bash
npm install -g @memstack/mcp
```

## Quick Start

Add to your MCP client config (~/.claude/mcp.json or .cursor/mcp.json):

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

## Configuration

All configuration is via environment variables. No config files needed.

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
| `MEMSTACK_ACTOR` | Default actor ID |

At least one of `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` must be set. Anthropic preferred if both are set.

### Embeddings (semantic search)

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI embeddings |

Without embedding config, retrieval falls back to keyword + importance search.

## Tools

The MCP server exposes these tools to the agent:

| Tool | Description |
|---|---|
| `memory_process` | Store with auto-enrichment (importance, tags) |
| `memory_store` | Store a memory |
| `memory_retrieve` | Retrieve memories by query, strategy, time range |
| `memory_compile_context` | Assemble token-budgeted LLM-ready context |
| `memory_summarize` | Compress old interactions via LLM |
| `memory_prune` | Remove stale/low-importance memories |
| `memory_purge_actor` | Delete all memories for an actor |
| `memory_merge` | Merge multiple memories into one |
| `memory_stats` | Memory diagnostics (counts, types, importance) |
| `memory_delete` | Delete a single memory |
| `memory_health` | Check storage/LLM/embedding connectivity |
| `memory_dry_run_prune` | Preview what would be pruned |

## Resources

| URI | Description |
|---|---|
| `memory://{actorId}/context` | Compiled LLM context as markdown |
| `memory://{actorId}/stats` | Actor memory stats as JSON |

## Prompts

| Prompt | Description |
|---|---|
| `memory_context` | Auto-injected memory context for current actor |

## Actor persistence

By default, all memories belong to the `"default"` actor. Set `MEMSTACK_ACTOR` to identify the agent:

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
