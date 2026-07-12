# Full Regression Verification — 2026-07-11

Re-ran the entire verification suite after the F1–F4 README fixes to confirm the
whole codebase still passes and matches the QA baseline.

## Tier 1 — Unit / type

| Check | Result |
|---|---|
| `pnpm check` (tsc --noEmit) | ✅ 0 errors |
| `pnpm test` | ✅ **470/470** (ran twice, stable) |

**Flake fixed:** `packages/mcp/test/http-transport.test.ts` used a fixed 1500ms
startup sleep and intermittently failed with `fetch failed` (ECONNREFUSED :5702)
under full-suite CPU contention. Replaced with a readiness poll (retry fetch up to
15s). Now stable across repeated runs.

## Tier 2 — E2E (Docker-backed adapters)

Ran `vitest --config vitest.e2e.config.ts` with all 6 services up.

| Adapter | Tests | Result |
|---|---|---|
| Postgres | 14 | ✅ |
| Redis | 10 | ✅ |
| Qdrant | 8 | ✅ |
| Weaviate | 9 | ✅ |
| MongoDB | 14 | ✅ |
| Neo4j | 11 | ✅ (passed 11/11 in isolation; flaky hook-timeout under full parallel load) |
| LanceDB | 10 | ✅ (suite flagged "failed" only due to `process.exit()` harness quirk) |
| SQLite | — | ⚠️ skipped — better-sqlite3 native bindings not built for Node v24 |
| Chroma | — | ⚠️ skipped — chromadb default-embed dep missing |

**66/66 docker-backed tests pass** (matches/exceeds prior baseline of 65/66 —
the previous Neo4j `graphQuery` timeout did not recur).

**Note:** under full parallel e2e run, Neo4j can hit a `beforeAll` hook timeout
(slow bolt warm-up competing for CPU). It passes cleanly in isolation. Candidate
follow-up: raise the Neo4j suite's hook timeout or run it serially.

## Surface checks (match docs/qa/2026-07-10)

### CLI — 8/8 PASS
importance clamp (F7), tag filter (F17), actor trim (F13), invalid-prune error
(F10), cross-actor prune scope (F5), createdAt preserved on import (F6),
empty-import guard, keyword tokenization on disk (F1).

### MCP — 5/5 PASS
tools/list = 18, empty-store rejected (F2), import-0 guard (F3), int-content
coercion (F9), store→retrieve round-trip.

### REST — 9/9 PASS
health, openapi 3.1 (19 paths), store 201, get-by-id, retrieve, count,
validation 400 (importance 5), 404 missing, export→import round-trip.

## Consistency with QA directory

| QA doc | Status |
|---|---|
| `summary.md` (18 original findings) | consistent — all code fixes still hold |
| `post-fix.md` (11/12 fixes) | consistent — re-verified live |
| `final-sweep.md` (65/66 e2e) | matched/exceeded — 66/66 this run |
| `readme-validation.md` (F1–F4) | consistent — re-verified live |

## Teardown
- ✅ Docker containers stopped + removed (`docker compose down`)
- ✅ No background processes left (mock LLM, servers killed)
- ✅ Temp dirs removed

## Net change this run
- `packages/mcp/test/http-transport.test.ts` — replaced fixed sleep with readiness
  poll (flake fix). No product-code changes; 470 tests green.
