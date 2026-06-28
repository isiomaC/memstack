# MemStack CLI — Command Reference

All commands output JSON to stdout. Errors go to stderr.

## store

Persist a new memory.

```bash
memstack store --actor "agent-1" --content "User reported login bug"
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--actor` | yes | string | Actor ID |
| `--content` | yes | string | Memory text |
| `--type` | no | `interaction` \| `summary` \| `observation` \| `fact` \| `reflection` | Memory classification (default: `interaction`) |
| `--importance` | no | float 0.0–1.0 | Survival priority |
| `--tags` | no | CSV string | `"bug,login,urgent"` |

Output: `{ "id": "mem_...", "actorId": "...", "content": "...", "memoryType": "interaction", "importance": 0.8, "tags": ["bug","login"], "createdAt": "..." }`

## retrieve

Query memories by actor, strategy, and filters.

```bash
memstack retrieve --actor "agent-1" --query "login" --strategy hybrid --limit 5
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--actor` | yes | string | Actor ID |
| `--query` | no | string | Search query (enables semantic/hybrid) |
| `--strategy` | no | `recent` \| `important` \| `semantic` \| `hybrid` | Default: `recent` |
| `--limit` | no | integer | Default: 10 |
| `--tags` | no | CSV string | Filter by tags |
| `--created-after` | no | ISO 8601 | `"2026-01-01T00:00:00Z"` |
| `--created-before` | no | ISO 8601 | `"2026-06-01T00:00:00Z"` |

Output: `[ Memory, Memory, ... ]`

## context

Compile LLM-ready system prompt from memories, token-budgeted.

```bash
memstack context --actor "agent-1" --max-tokens 2000
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--actor` | yes | string | Actor ID |
| `--max-tokens` | no | integer | Token budget (default: 2000) |

Output: `{ "systemPrompt": "## Important Memories\n- ...", "recentMemories": [...], "importantMemories": [...], "tokenEstimate": 280 }`

## summarize

Compress old interactions into a summary via LLM.

```bash
memstack summarize --actor "agent-1" --older-than 7d
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--actor` | yes | string | Actor ID |
| `--older-than` | no | duration | `"7d"`, `"24h"`, `"30m"`, `"10s"` |

Output: `{ "summary": { Memory }, "deletedCount": 47 }`

## prune

Remove stale memories by strategy.

```bash
memstack prune --actor "agent-1" --type byAge --max-age 30d
memstack prune --actor "agent-1" --type byImportance --min-importance 0.3
memstack prune --actor "agent-1" --type byCount --max-count 500
memstack prune --actor "agent-1" --type byAge --max-age 7d --dry-run
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--actor` | yes | string | Actor ID |
| `--type` | no | `byAge` \| `byImportance` \| `byCount` | Default: `byAge` |
| `--max-age` | no | duration | For `byAge`: `"30d"`, `"24h"` |
| `--min-importance` | no | float 0.0–1.0 | For `byImportance` |
| `--max-count` | no | integer | For `byCount`: keep top N |
| `--dry-run` | no | flag | Preview only, no deletion |

Output (dry-run): `{ "kept": [...], "wouldPrune": [...], "count": { "kept": 100, "wouldPrune": 50 } }`
Output (real): `{ "kept": [...], "deleted": [...], "count": { "kept": 100, "deleted": 50 } }`

## purge

Delete all memories for an actor.

```bash
memstack purge --actor "agent-1"
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--actor` | yes | string | Actor ID |

Output: `42` (number of deleted memories)

## merge

Combine multiple memories into one. Uses the highest-importance memory as the base.

```bash
memstack merge --ids "mem_abc,mem_def,mem_ghi"
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--ids` | yes | CSV of memory IDs | `"mem_abc,mem_def"` |

Output: `{ Memory }` (merged result)

## stats

Get memory diagnostics.

```bash
memstack stats --actor "agent-1"
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--actor` | no | string | If omitted, returns all actors |

Output: `{ "total": 1500, "expired": 3, "oldest": "...", "newest": "...", "avgImportance": 0.6, "byType": { "interaction": 1200, "summary": 300 }, "byActor": { "agent-1": 1500 } }`

## delete

Remove a single memory by ID.

```bash
memstack delete --id "mem_abc123"
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--id` | yes | string | Memory ID |

Output: `{ "deleted": true }`

## health

Check connectivity to storage, LLM, and embedding backends.

```bash
memstack health
```

No flags required.

Output: `{ "storage": true, "llm": true, "embedding": true }`

## export

Export memories as a JSON snapshot.

```bash
memstack export --actor "agent-1"
memstack export --actor "agent-1" --out ./backup.json
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--actor` | no | string | If omitted, exports all actors |
| `--out` | no | string | File path; if omitted, prints to stdout |

Output (stdout): `{ "version": 1, "memories": [...], "exportedAt": "..." }`
Output (file): `{ "saved": "./backup.json", "count": 1500 }`

## import

Import memories from a JSON snapshot file.

```bash
memstack import --actor "agent-1" --file ./backup.json
```

| Flag | Required | Type | Description |
|---|---|---|---|
| `--actor` | yes | string | Target actor ID |
| `--file` | yes | string | JSON file path |

Accepts both snapshot objects (`{ version, memories, exportedAt }`) and plain arrays of Memory objects.

Output: `{ "imported": 1500 }`

## Duration format

Durations use `{number}{unit}` suffix: `s` (seconds), `m` (minutes), `h` (hours), `d` (days).

```
7d  = 7 days (604800000 ms)
24h = 24 hours (86400000 ms)
30m = 30 minutes (1800000 ms)
10s = 10 seconds (10000 ms)
```
