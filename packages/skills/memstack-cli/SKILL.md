---
name: memstack-cli
description: Persistent cross-session memory for AI agents using the @memstack/cli shell tool. Stores, retrieves, summarizes, and prunes memories so agents remember past interactions. Use when the agent needs memory, wants to remember user preferences, track progress across sessions, or mentions "memory", "remember", "memstack", or "store/retrieve memories".
---

# MemStack CLI

## Quick start

Install and verify:

```bash
npm install -g @memstack/cli
memstack health
# {"storage":true,"llm":true,"embedding":true}
```

All output is JSON to stdout. Errors go to stderr.

## Configuration

All via environment variables. At minimum, set an LLM API key:

```bash
export OPENAI_API_KEY=sk-...          # OpenAI LLM + embeddings
export MEMSTACK_STORAGE=disk          # default: memory
export MEMSTACK_DIR=./memories        # for disk/markdown storage
```

| Variable | Purpose | Default |
|---|---|---|
| `MEMSTACK_STORAGE` | Backend: `memory`, `disk`, `markdown`, `postgres`, `sqlite`, `redis` | `memory` |
| `OPENAI_API_KEY` | LLM + embeddings | — |
| `ANTHROPIC_API_KEY` | Alternative LLM (summarization; preferred if both set) | — |
| `MEMSTACK_OPENAI_BASE_URL` | Custom endpoint (DeepSeek, Together AI, etc.) | `https://api.openai.com/v1` |
| `MEMSTACK_LLM_MODEL` | Model override | `gpt-4o-mini` |
| `MEMSTACK_DIR` | Directory for disk/markdown | `./memories` |
| `DATABASE_URL` | Postgres connection (required if `postgres`) | — |
| `SQLITE_PATH` | SQLite database path (required if `sqlite`) | `./memstack.db` |
| `REDIS_URL` | Redis connection (required if `redis`) | `redis://localhost:6379` |
| `MEMSTACK_EMBED_ON_STORE` | Auto-embed on store | `true` |

## Memory loop (core pattern)

Run this on every agent turn:

```
1. RETRIEVE context → inject into system prompt
2. RESPOND to the user
3. STORE the interaction as a memory
4. Periodically: SUMMARIZE old + PRUNE stale
```

### Step 1 — Retrieve context before responding

```bash
CONTEXT=$(memstack context --actor "$AGENT_ID" --max-tokens 2000)
SYSTEM_PROMPT=$(echo "$CONTEXT" | jq -r '.systemPrompt')
```

The system prompt is markdown-formatted, token-budgeted, and ready to prepend to your LLM call.

### Step 2 — Store after the turn

```bash
memstack store \
  --actor "$AGENT_ID" \
  --content "User asked about login; I explained the password reset flow" \
  --type interaction \
  --importance 0.7 \
  --tags "login,support"
```

Returns: `{"id":"mem_...","actorId":"agent-1","content":"...","createdAt":"..."}`

### Step 3 — Periodic maintenance

```bash
# Summarize interactions older than 7 days
memstack summarize --actor "$AGENT_ID" --older-than 7d

# Prune low-importance or old memories
memstack prune --actor "$AGENT_ID" --type byAge --max-age 30d
memstack prune --actor "$AGENT_ID" --type byImportance --min-importance 0.3
```

## Retrieval strategies

```bash
memstack retrieve --actor "$AGENT_ID" --strategy recent
memstack retrieve --actor "$AGENT_ID" --query "login bug" --strategy hybrid --limit 10
memstack retrieve --actor "$AGENT_ID" --tags "billing" --limit 5
```

Valid strategies: `recent`, `important`, `semantic`, `hybrid`. Without `--query`, semantic/hybrid fall back to keyword+importance matching.

## Best practices

- **Actor ID convention**: Use consistent IDs — `"agent-name"`, `"project/thread"`, or `"user-id"`. Same ID groups related memories.
- **Importance scoring**: 0.0–1.0. `>0.7` for critical info (preferences, decisions), `0.3–0.7` for useful context, `<0.3` for routine exchanges.
- **Token budget**: Defaults to 2000. For long-running agents, use 800–1500 to leave room for the conversation.
- **Storage backend**: `disk` for simple local use. `markdown` for git-diffable, human-readable files. `postgres`/`redis` for production scale.
- **Maintenance frequency**: Summarize every 50–100 interactions. Prune every 100–200. Use `--dry-run` on prune to preview before deleting.
- **Tags over content**: Use tags for filtering (`--tags "billing,urgent"`) rather than relying on keyword search alone.

See [REFERENCE.md](REFERENCE.md) for all 12 commands, complete flags, and output schemas.
