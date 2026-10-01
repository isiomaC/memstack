# @memstack/cli

CLI for MemStack — shell-based agent memory. Connect Claude Code and Codex to one shared memory per project, or use it from bash scripts, CI pipelines, or any subprocess-capable agent.

## Installation

```bash
npm install -g @memstack/cli
# or
npx @memstack/cli [command]
```

## Claude Code and Codex

Give both agents one persistent memory per project. MemStack never installs
storage drivers; install the one for your store with the MCP server:

```bash
npm install -g @memstack/cli @memstack/mcp better-sqlite3@^11.10.0
memstack init                   # LLM provider + store → ~/.memstack/config.json
memstack connect claude-code
memstack connect codex          # then approve the MemStack hook once in Codex with /hooks
```

| Command | What it does |
|---|---|
| `init` | Choose an LLM provider and store; verifies the key with a real request. Non-interactive: `--provider openai-compatible\|anthropic --base-url <url> --model <name> --api-key-env <VAR> --store <type> [--path <file> \| --url <url>] --yes`. |
| `connect <claude-code\|codex>` | Registers your installed `memstack-mcp`, adds a session-start hook that loads project memories, and for Codex a marked block in `~/.codex/AGENTS.md`. Checks the server first and undoes everything if a step fails. `--dry-run`, `--no-hooks`, `--no-agents-md`. |
| `disconnect <claude-code\|codex>` | Removes everything `connect` added, restoring each file exactly. Memories are kept. |
| `status` | Config, storage, the current project, and each agent's connection, hook, and guidance. |
| `doctor` | Diagnoses problems and prints the fix for each. `--live` tests the LLM key. Exits non-zero when it finds a problem. |
| `memories [query]` | Lists or searches the current project's memories. `--global`, `--limit <n>`, `--delete <id>`. |
| `project` | Shows the current project ID. `project pin <id>` writes `.memstack.json`; `project merge <old-id>` moves memories from an old ID. |

These commands print readable text, not JSON, and read
`~/.memstack/config.json` (or `$MEMSTACK_HOME/config.json`) overlaid with the
environment variables below. Projects are identified by the repository's
first commit, so clones, worktrees, and renamed remotes share memories. See
[Harness Memory](https://github.com/isiomaC/memstack#harness-memory-claude-code--codex)
for details.

## Configuration

The memory commands below are configured by environment variables only. Same scheme as @memstack/mcp.

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

The memory commands below print JSON to stdout. Errors go to stderr.

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

Each memory's original `createdAt` is preserved on import (round-trips exactly with `export`). Importing a snapshot with zero memories fails cleanly with a non-zero exit.

## Input validation

The CLI normalizes and validates input before storing:

- **`--importance`** is clamped to the `0.0–1.0` range (e.g. `--importance 5` stores as `1`, `--importance=-1` stores as `0`).
- **`--actor`** is trimmed of leading/trailing whitespace (`--actor "  a  "` and `--actor a` are the same actor).
- **`--tags`** drops empty entries from trailing/double commas (`--tags "a,,b,"` → `["a","b"]`).
- **`prune --type`** rejects unknown strategies with a non-zero exit instead of silently doing nothing. Valid: `byAge`, `byImportance`, `byCount`, `byType`, `custom`, `compose`.
- **`prune --actor`** is scoped to that actor only — it never touches other actors' memories.

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
