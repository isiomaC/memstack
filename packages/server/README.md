# @memstack/server

REST API server for MemStack — self-hostable agent memory. Runs on Node.js 18+ or Bun.

## Installation

```bash
npm install @memstack/server
# or via Docker:
docker pull ghcr.io/isiomac/memstack-server:0.6.4
```

## Quick Start

```bash
# Node.js
npx @memstack/server
# or, if installed as a dependency:
node node_modules/@memstack/server/dist/serve.js

# Bun
bun run node_modules/@memstack/server/dist/index.js

# Docker
docker run -p 3000:3000 -e MEMSTACK_STORAGE=memory -e OPENAI_API_KEY=sk-... ghcr.io/isiomac/memstack-server:0.6.4
```

Under Node, `dist/serve.js` starts the server explicitly via [`@hono/node-server`](https://github.com/honojs/node-server). Under Bun, `dist/index.js`'s default export (`{ port, fetch }`) is auto-started by the Bun runtime — no extra wiring needed. Both entry points serve the same Hono app, so behavior is identical either way.

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
| `MEMSTACK_EMBED_ON_STORE` | Auto-embed on store | `true` |
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
| `GET` | `/v1/summarize/stream` | Stream summary via SSE |
| `POST` | `/v1/prune` | Remove stale memories |
| `POST` | `/v1/prune/dry-run` | Preview prune |
| `GET` | `/v1/stats/:actorId` | Memory diagnostics |
| `GET` | `/health` | Health check |
| `GET` | `/openapi.json` | OpenAPI 3.1 spec, generated from the request-validation schemas below |

## Request validation

Every `POST` body is validated against a [zod](https://zod.dev) schema before it reaches MemStack. Invalid requests get a `400` with details instead of a generic `500`:

```bash
curl -X POST http://localhost:3000/v1/memories \
  -H "Content-Type: application/json" \
  -d '{"actorId":"agent-1","importance":5}'
# 400 { "error": "Validation failed", "issues": [
#   { "path": ["content"], "message": "Required" },
#   { "path": ["importance"], "message": "Number must be less than or equal to 1" }
# ]}
```

`GET /openapi.json` serves the generated OpenAPI 3.1 document — paste it into [Swagger UI](https://swagger.io/tools/swagger-ui/), [Redoc](https://redocly.com/redoc), or Postman, or run it through an OpenAPI code generator to get a typed client in any language. The request-body schemas in the spec come from the same zod schemas that validate incoming requests, so they can't drift apart.

Note: `POST /v1/prune` and `/v1/prune/dry-run` support every `PruneStrategy` type except `"custom"` — a custom prune strategy is a JavaScript predicate function, which can't be expressed in JSON. Use the `@memstack/core` library directly for custom prune logic.

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

# Stream summarization (SSE)
curl -N "http://localhost:3000/v1/summarize/stream?actorId=agent-1&olderThan=2026-01-01T00:00:00Z"
```

## Docker

```bash
docker run -p 3000:3000 \
  -e MEMSTACK_STORAGE=postgres \
  -e DATABASE_URL=postgresql://... \
  -e OPENAI_API_KEY=sk-... \
  ghcr.io/isiomac/memstack-server:0.6.4
```

## License

MIT
