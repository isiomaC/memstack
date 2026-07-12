# MemStack Manual QA Index

Live, human-style QA test history. Each session follows `docs/e2e-plan.md`.

## Sessions

| Date | Tester | Surfaces | Status | Findings | Report |
|---|---|---|---|---|---|
| 2026-07-10 | opencode (automated agent) | A,B,C,D,E | complete (D blocked) | 18 (5 crash) | [2026-07-10/summary.md](./2026-07-10/summary.md) |
| 2026-07-10 | opencode | fix-verify | complete | 11/12 fixes verified | [2026-07-10/post-fix.md](./2026-07-10/post-fix.md) |
| 2026-07-11 | opencode | final-sweep | complete | 65/66 e2e, 8/8 CLI | [2026-07-10/final-sweep.md](./2026-07-10/final-sweep.md) |
| 2026-07-11 | opencode | readme-validation | complete | 4 doc/code issues fixed (F1–F4) | [2026-07-10/readme-validation.md](./2026-07-10/readme-validation.md) |
| 2026-07-11 | opencode | regression-verification | complete | 470 unit, 66/66 e2e, 22 surface checks; 1 flake fixed | [2026-07-10/regression-verification.md](./2026-07-10/regression-verification.md) |

## Coverage Matrix

| Surface | Last Tested | Status | Notes |
|---|---|---|---|
| A — CLI | 2026-07-11 | ✅ PASS | All fixes verified: prune scoped, createdAt preserved, importance clamped, tags filtered, actor trimmed |
| B — MCP | 2026-07-10 | ✅ PASS | Fixes verified: empty args rejected, import guarded, content stringified |
| C — REST | 2026-07-10 | ✅ PASS | Clean surface, no regressions |
| D — Docker/GHCR | 2026-07-10 | ⚠️ NEEDS CI | zod fix applied, image needs rebuild |
| E — Core adapters | 2026-07-11 | ✅ PASS | 65/66 e2e pass, createdAt preserved across all 18 adapters |

## Known Untestable (per plan)

Pinecone, Upstash, Mem0, Zep — require cloud credentials. Covered by mocked unit tests only.

## Severity Summary

| Severity | Count | Key issues |
|---|---|---|
| crash | 5 | Docker image broken (zod), MCP empty-args store, MCP import crash, Anthropic no-SDK crash, MCP empty args → garbage data |
| wrong-output | 7 | Cross-actor prune, import overwrites createdAt, importance out-of-range, invalid prune silent, LLM text-vs-content key, MCP int content accepted, MCP empty store creates default actor |
| confusing-but-works | 3 | MCP unknown tool silent, actorId not trimmed, delete non-existent errors |
| docs-mismatch | 3 | Docker tag wrong, disk concurrency data loss, better-sqlite3 bindings missing |
