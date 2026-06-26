# @memstack/server

REST API server for MemStack — self-hostable agent memory. Run anywhere Bun runs.

## Installation

```bash
npm install @memstack/server
# or via Docker:
docker pull ghcr.io/isiomac/memstack-server:v0.5.0
```

## Quick Start

```bash
bun run node_modules/@memstack/server/dist/index.js
# or via Docker:
docker run -p 3000:3000 -e MEMSTACK_STORAGE=memory -e OPENAI_API_KEY=sk-... ghcr.io/isiomac/memstack-server:v0.5.0
```

## Configuration

All via environment variables.

| Variable | Purpose | Default |
|---|---|---|
| `MEMSTACK_STORAGE` | Storage backend (memory, disk, markdown, postgres, sqlite, redis) | `memory` |
| `MEMSTACK_DIR` | Directory for markdown/disk | `./memories` |
| `DATABASE_URL` | Postgres connection | — |
| `SQLITE_PATH` | SQLite database path | `./memstack.db` |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` |
| `OPENAI_API_KEY` | OpenAI LLM + embeddings | — |
| `ANTHROPIC_API_KEY` | Anthropic LLM (summarization) | — |
| `MEMSTACK_OPENAI_BASE_URL` | Custom API endpoint (DeepSeek, etc) | `https://api.openai.com/v1` |
| `MEMSTACK_LLM_MODEL` | Model override | `gpt-4o-mini` |
| `MEMSTACK_API_KEY` | Bearer token auth (optional) | — |
| `MEMSTACK_RATE_LIMIT` | Requests/minute limit | 0 (disabled) |
| `PORT` | HTTP port | 3000 |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/memories` | Store a memory |
| `POST` | `/v1/memories/batch` | Store multiple memories |
| `POST` | `/v1/memories/retrieve` | Retrieve memories |
| `POST` | `/v1/memories/context` | Compile LLM-ready context |
| `POST` | `/v1/memories/process` | Store with auto-enrichment |
| `POST` | `/v1/memories/merge` | Merge multiple memories |
| `POST` | `/v1/memories/purge` | Delete all for an actor |
| `POST` | `/v1/memories/delete-many` | Delete multiple by ID |
| `POST` | `/v1/memories/import` | Import JSON snapshot |
| `GET` | `/v1/memories/:id` | Get by ID |
| `DELETE` | `/v1/memories/:id` | Delete by ID |
| `POST` | `/v1/memories/:id/touch` | Bump recency |
| `GET` | `/v1/memories/count` | Count with filters |
| `GET` | `/v1/memories/export` | Export snapshot |
| `POST` | `/v1/summarize` | Compress old memories |
| `POST` | `/v1/prune` | Remove stale memories |
| `POST` | `/v1/prune/dry-run` | Preview prune |
| `GET` | `/v1/stats/:actorId` | Memory diagnostics |
| `GET` | `/health` | Health check |

## Usage Examples

```bash
# Health check
curl http://localhost:3000/health

# Store a memory
curl -X POST http://localhost:3000/v1/memories \
  -H "Content-Type: application/json" \
  -d '{"actorId":"agent-1","content":"User reported login bug","importance":0.8}'

# Retrieve
curl -X POST http://localhost:3000/v1/memories/retrieve \
  -H "Content-Type: application/json" \
  -d '{"actorId":"agent-1"}'

# Compile context
curl -X POST http://localhost:3000/v1/memories/context \
  -H "Content-Type: application/json" \
  -d '{"actorId":"agent-1","maxTokens":500}'
```

## Docker

```bash
docker run -p 3000:3000 \
  -e MEMSTACK_STORAGE=postgres \
  -e DATABASE_URL=postgresql://... \
  -e OPENAI_API_KEY=sk-... \
  ghcr.io/isiomac/memstack-server:v0.5.0
```

## License

MIT
