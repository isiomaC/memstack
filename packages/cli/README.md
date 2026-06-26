# @memstack/cli

CLI for MemStack — shell-based agent memory. Use from bash scripts, Claude Code shell tool, CI pipelines, or any subprocess-capable agent.

## Installation

```bash
npm install -g @memstack/cli
# or
npx @memstack/cli [command]
```

## Configuration

All via environment variables. Same scheme as @memstack/mcp.

| Variable | Purpose | Default |
|---|---|---|
| `MEMSTACK_STORAGE` | Storage backend | `memory` |
| `MEMSTACK_DIR` | Directory for markdown/disk | `./memories` |
| `DATABASE_URL` | Postgres connection | — |
| `SQLITE_PATH` | SQLite database path | `./memstack.db` |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` |
| `OPENAI_API_KEY` | OpenAI LLM + embeddings | — |
| `ANTHROPIC_API_KEY` | Anthropic LLM (summarization) | — |
| `MEMSTACK_OPENAI_BASE_URL` | Custom API endpoint (DeepSeek, etc.) | `https://api.openai.com/v1` |
| `MEMSTACK_LLM_MODEL` | Model override | `gpt-4o-mini` |
| `MEMSTACK_EMBED_ON_STORE` | Auto-embed on store | `true` |

## Commands

All output is JSON to stdout. Errors go to stderr.

### store
```bash
memstack store --actor "agent-1" --content "User reported login bug" --type interaction --importance 0.8 --tags "bug,login"
# {"id":"mem_...","actorId":"agent-1","content":"User reported login bug",...}
```

### retrieve
```bash
memstack retrieve --actor "agent-1" --query "login" --strategy hybrid --limit 5
memstack retrieve --actor "agent-1" --created-after "2026-01-01T00:00:00Z" --created-before "2026-06-01T00:00:00Z"
```

### context
```bash
memstack context --actor "agent-1" --max-tokens 2000
# {"systemPrompt":"## Important Memories\n- ...", "tokenEstimate": 280, ...}
```

### summarize
```bash
memstack summarize --actor "agent-1" --older-than 7d
# {"summary": {...}, "deletedCount": 47}
```

### prune
```bash
memstack prune --actor "agent-1" --type byAge --max-age 30d
memstack prune --actor "agent-1" --type byImportance --min-importance 0.3
memstack prune --actor "agent-1" --type byCount --max-count 500
memstack prune --actor "agent-1" --type byAge --max-age 7d --dry-run  # preview only
```

### purge
```bash
memstack purge --actor "agent-1"
# 42  (number of deleted memories)
```

### merge
```bash
memstack merge --ids "mem_abc,mem_def,mem_ghi"
# {merged memory object}
```

### stats
```bash
memstack stats --actor "agent-1"
# {"total":1500,"expired":3,"oldest":"...","newest":"...","avgImportance":0.6,...}
```

### delete
```bash
memstack delete --id "mem_abc123"
# {"deleted":true}
```

### health
```bash
memstack health
# {"storage":true,"llm":true,"embedding":true}
```

### export
```bash
memstack export --actor "agent-1"
memstack export --actor "agent-1" --out ./backup.json
# {"saved":"./backup.json","count":1500}
```

### import
```bash
memstack import --actor "agent-1" --file ./backup.json
# {"imported":1500}
```

## Shell agent usage

```bash
#!/bin/bash
AGENT_ID="support-bot"

# Before each turn: inject memory context
CONTEXT=$(memstack context --actor "$AGENT_ID" --max-tokens 1500)
SYSTEM_PROMPT=$(echo "$CONTEXT" | jq -r '.systemPrompt')

# After each turn: store what happened
memstack store --actor "$AGENT_ID" --content "$TURN_SUMMARY" --type interaction

# Periodic maintenance
memstack prune --actor "$AGENT_ID" --type byAge --max-age 30d
```

## Publishing

```bash
cd packages/cli
pnpm build && pnpm check && pnpm test
npm publish --access public
```

After publishing, users install with:

```bash
npm install -g @memstack/cli
```

## License

MIT
