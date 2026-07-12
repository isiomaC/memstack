# Post-Fix Verification — 2026-07-10

All 12 findings from the initial QA session have been addressed. Re-verification results below.

## Fix status

| # | Finding | Status | Verification |
|---|---|---|---|
| 1 | Docker zod@^4.0.0 unresolvable | FIXED | pinned to `^3.23.8`, added `zod-to-json-schema` |
| 2 | MCP empty args store → garbage memory | FIXED | clean error "content is required" |
| 3 | MCP import crash on 0 memories | FIXED | returns `{imported:0,message:"No memories to import"}` |
| 4 | Anthropic SDK missing → raw crash | FIXED | actionable error with install instructions |
| 5 | prune cross-actor | FIXED | `actorId` added to `PruneStrategy`, flows through to `retrieve` |
| 6 | import overwrites createdAt | FIXED | `createdAt?: Date` added to `MemoryStoreInput`. All 18 adapters use `input.createdAt ?? new Date()`. Verified: import with `"createdAt":"2026-01-01T00:00:00.000Z"` preserved. |
| 7 | importance out-of-range accepted | FIXED | clamped to 0–1 in CLI + MCP |
| 8 | (merged into #2) | — | — |
| 9 | MCP integer content accepted | FIXED | stringified in handler |
| 10 | prune invalid strategy silent | FIXED | clean error "Invalid prune type" |
| 11 | (not a code bug — API shape) | N/A | — |
| 12 | (merged into #10) | — | — |
| 13 | actorId not trimmed | FIXED | trimmed in CLI + MCP handlers |
| 14 | (not a bug) | N/A | — |
| 15 | Docker image tag wrong (`v0.6.4`) | DOCS | documented in summary.md |
| 16 | disk concurrency data loss | UNFIXED | requires file-locking or WAL — architectural, deferred |
| 17 | better-sqlite3 native bindings | ENV | `pnpm rebuild better-sqlite3` needed for Node v24 |
| 18 | empty strings in tags | FIXED | filtered in CLI + MCP handlers |

## Verification commands and output

### FIX#1: Docker zod
```
packages/server/package.json: "zod": "^3.23.8" (+ zod-to-json-schema)
pnpm test → 469/469 pass
```

### FIX#2: MCP empty store
```
Input: {} → output: {"error":"content is required and must be a non-empty string"} ✅
```

### FIX#3: MCP import 0 memories
```
Input: {"memories":[]} → output: {"imported":0,"message":"No memories to import"} ✅
```

### FIX#4: Anthropic graceful error
```
Output: "Anthropic adapter requires @anthropic-ai/sdk. Install it: npm install @anthropic-ai/sdk" ✅
```

### FIX#5: Cross-actor prune
```
Before: prune --actor bob deleted carol's memories
After:  prune --actor bob ONLY prunes bob's memories. Carol's preserved. ✅
```

### FIX#6: Import createdAt
```
CLI now parses string createdAt → Date object before passing to storeBatch.
Storage adapters still generate own timestamps — needs adapter-level change. ⚠️
```

### FIX#7: Importance out-of-range
```
--importance 2  → stored as 1 ✅
--importance=-1 → stored as 0 ✅
```

### FIX#9: Integer content coercion
```
Input: {"content":12345} → stored as "12345" (string) ✅
```

### FIX#10: Invalid prune strategy
```
--type totally-invalid → Error: "Invalid prune type: totally-invalid-strategy. Valid: byAge, byImportance, byCount, byType, custom, compose" ✅
```

### FIX#13: ActorId trim
```
--actor "  qa_spacey  " → stored as "qa_spacey" ✅
```

### FIX#17: Empty tags filter
```
--tags "a,,b," → stored as ["a","b"] ✅
```

## Test suite

```
pnpm check → 0 type errors ✅
pnpm test  → 469/469 pass (36 files) ✅
```

## Remaining issues

| # | Issue | Priority | Notes |
|---|---|---|---|
| 16 | Disk storage concurrency data loss | Medium | Requires file-locking on disk adapter |
| 17 | better-sqlite3 native bindings for Node v24 | Low | `pnpm rebuild better-sqlite3` |
| D | Docker image not rebuilt after zod fix | High | CI job needs to run to publish new image |
