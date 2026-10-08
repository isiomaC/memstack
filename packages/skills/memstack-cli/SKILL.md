---
name: memstack-cli
description: Persistent cross-session memory for AI agents using the @memstack/cli shell tool. Stores, retrieves, summarizes, and prunes memories so agents remember past interactions. Use when the agent needs memory, wants to remember user preferences, track progress across sessions, or mentions "memory", "remember", "memstack", or "store/retrieve memories".
---

# MemStack CLI

## Inside Claude Code or Codex

Use MemStack's built-in integration, not the shell commands further down. It
gives you project-scoped `memory_store` and `memory_retrieve` tools, loads key
memories at the start of every session, and shares one memory per repository
between Claude Code and Codex.

1. Run `memstack status`.
2. If your harness shows `connected`, use the `memory_store` and
   `memory_retrieve` tools. When the user says "remember…", store it with
   `memory_store`, not in a file. You're done; skip the rest of this skill.
3. If it isn't connected, set it up. The packages are installed by the user,
   because MemStack never installs storage drivers:

   ```bash
   npm install -g @memstack/cli @memstack/mcp better-sqlite3@^11.10.0
   memstack init                  # LLM provider + store; flags: memstack init --help
   memstack connect claude-code   # and/or: memstack connect codex
   memstack doctor                # verifies the setup and prints fixes
   ```

   Then tell the user to restart the harness (in Codex, approve the
   session-start hook once with `/hooks`).

If you must use the shell anyway, for example before the restart, pass
`--project` instead of `--actor`. That stores into the same project memory the
tools and `memstack memories` use. Don't invent an actor ID for a project:
those memories never reach the other harness. In Codex's default sandbox, shell
writes to a store outside the workspace fail; use the tools instead.

`memstack memories [query]` lists the current project's memories,
`memstack status` shows what is connected, and `memstack disconnect <harness>`
removes it. These commands print readable text.

## Other agents: quick start

Install and verify:

```bash
npm install -g @memstack/cli
memstack health
# {"storage":true,"llm":true,"embedding":true}
```

All output is JSON to stdout. Errors go to stderr. `memstack <command> --help`
prints a command's flags.

## Configuration

Every command reads `~/.memstack/config.json`, written by `memstack init`.
Environment variables override it: any LLM variable replaces its LLM settings,
and `MEMSTACK_STORAGE` replaces its storage settings. `memstack status` shows
which source is in use. The LLM key is optional for the harness (it only tags
memories as they are saved; recall never uses it): `memstack init --no-llm`
skips it. Other commands that call the LLM need one. Without a config file,
set at least an LLM API key:

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

- **Actor ID convention**: In a code repository, use `--project`. Otherwise use consistent IDs — `"agent-name"`, `"project/thread"`, or `"user-id"`. Same ID groups related memories.
- **Importance scoring**: 0.0–1.0. `>0.7` for critical info (preferences, decisions), `0.3–0.7` for useful context, `<0.3` for routine exchanges.
- **Memory types**: `--type preference`, `decision`, or `instruction` for durable choices and rules; `fact` and `observation` for knowledge; `interaction` for routine exchanges.
- **Token budget**: Defaults to 2000. For long-running agents, use 800–1500 to leave room for the conversation.
- **Storage backend**: `disk` for simple local use. `markdown` for git-diffable, human-readable files. `postgres`/`redis` for production scale.
- **Maintenance frequency**: Summarize every 50–100 interactions. Prune every 100–200. Use `--dry-run` on prune to preview before deleting.
- **Tags over content**: Use tags for filtering (`--tags "billing,urgent"`) rather than relying on keyword search alone.

See [REFERENCE.md](REFERENCE.md) for all memory commands, complete flags, and output schemas, plus the harness commands.
