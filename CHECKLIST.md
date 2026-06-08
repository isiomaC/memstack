# MemStack — Publish Readiness Checklist

Each item defines its scope, verification condition, and assignee. Mark `[x]` only after **independent verification** — the orchestrator runs the check itself, not trusting the subagent's self-report.

## Phase 1: Foundation

- [x] 1.1 Type safety and build
  **Agent:** @implementer
  **Scope:** `tsc --noEmit` passes with zero errors. Build produces CJS (`dist/index.js`), ESM (`dist/index.mjs`), and declarations (`dist/index.d.ts`).
  **Verify:** `pnpm check` exits 0. `pnpm build` exits 0. `dist/index.d.ts` exports all public types.

- [x] 1.2 Test suite green
  **Agent:** @tester
  **Scope:** All 39 existing tests pass. Run `pnpm test` and confirm zero failures.
  **Verify:** `pnpm test` exits 0 with 39 passed.

## Phase 2: Bug Fixes (Known Issues from AGENTS.md)

- [x] 2.1 Fix `touch()` identity loss
  **Agent:** @implementer
  **Scope:** `MemoryStore.touch()` deletes + re-stores, giving memory a new ID and createdAt. Implement `StorageProvider.touch(id)` method (or equivalent) to update timestamps in-place. All storage adapters must implement it. DiskStorage's retrieve() already touches via `_touchedAt` — harmonize with the new approach.
  **Verify:** After `touch(id)`, `get(id)` returns the same memory with same ID but updated createdAt. Test added.

- [x] 2.2 Remove unused error codes
  **Agent:** @implementer
  **Scope:** Remove `QUEST_ERROR` and `RELATIONSHIP_ERROR` from `MemStackErrorCode` in `errors.ts`.
  **Verify:** `pnpm check` passes. Grep confirms no references remain.

- [x] 2.3 Fix README vs implementation mismatches
  **Agent:** @implementer
  **Scope:** 
  - Remove or fix `maxMemoriesPerActor` and `importanceDecayRate` from `MemStackConfig` defaults docs — they don't exist in the interface.
  - Fix `predicate` → `shouldRemove` in custom prune docs.
  - Fix `import { Summarizer } from "@memstack/core"` — either add Summarizer to barrel export or remove from README.
  **Verify:** README code examples match actual API surface. `pnpm check` passes.

- [x] 2.4 Update README test count
  **Agent:** @implementer
  **Scope:** README says "14 tests" but actual is 39. Update to current count.
  **Verify:** README reflects actual test count.

- [x] 2.5 Bump version
  **Agent:** @implementer
  **Scope:** Update `package.json` version to `0.2.0` (v0.2 features are complete per TODO.md).
  **Verify:** `package.json` version is `0.2.0`.

## Phase 3: Adapter Audit

- [ ] 3.1 LLM adapter edge cases
  **Agent:** @implementer
  **Scope:** 
  - Anthropic: Add `completeStream()` support.
  - Ollama: Add `completeStream()` support.
  - Verify all adapters handle empty responses, non-200 HTTP status codes, network timeouts gracefully (wrap in MemStackError).
  - Verify Groq adapter handles missing `x_groq.usage` header gracefully.
  **Verify:** Each adapter errors gracefully on simulated failures.

- [x] 3.2 Storage adapter edge cases
  **Agent:** @implementer
  **Scope:**
  - DiskStorage: Handle concurrent writes to same actor file (add file lock or accept overwrite).
  - DiskStorage: Handle corrupted JSON files (return empty array, don't crash).
  - RedisStorage: Test with mock Redis client (verify key patterns, TTLs, Lua scripts if used).
  - PostgresStorage: Fix unused `_paramIdx` parameter in `_semanticRetrieve`.
  **Verify:** Each adapter handles edge cases without throwing uncaught errors.

- [ ] 3.3 Embedding adapter edge cases
  **Agent:** @implementer
  **Scope:**
  - Cohere: Verify error handling for invalid API keys, rate limits.
  - Both adapters: Verify empty input arrays (return empty array, don't call API).
  **Verify:** Graceful error handling on simulated failures.

## Phase 4: Core Pipeline Hardening

- [ ] 4.1 MemoryStore edge cases
  **Agent:** @implementer
  **Scope:**
  - `summarize()` with zero matching memories (should throw clear error, not crash).
  - `prune()` with zero memories (should return `{ pruned: [], count: 0 }`).
  - `compileContext()` with zero memories (should return empty system prompt).
  - `onConflict: "append"` with 0 existing memories (should store new).
  - `storeBatch()` with empty array (should return []).
  - `deleteMany()` with empty array (should return 0).
  **Verify:** Each edge case tested and handled gracefully.

- [ ] 4.2 Token estimation accuracy
  **Agent:** @implementer
  **Scope:** ContextCompiler's `_estimateTokens()` approximates ~4 chars per token for English, ~3 for code. Verify CJK text, URLs, and mixed content don't cause severe under/over-estimation.
  **Verify:** Tests pass for diverse content types. `tokenEstimate` is within +-50% of actual token count for common inputs.

- [ ] 4.3 Auto-enrichment batching correctness
  **Agent:** @implementer
  **Scope:** When both `autoImportance` and `autoTags` are enabled, a single LLM call batches both. Verify the batching logic correctly handles partial failures (LLM returns valid importance but invalid tags, or vice versa).
  **Verify:** `_parseEnrichmentJson()` handles all edge cases. Tests added.

## Phase 5: Tests

- [x] 5.1 Missing unit tests
  **Agent:** @tester
  **Scope:**
  - Pruner: Test each of the 5 strategies independently (byAge, byImportance, byCount, byType, custom).
  - Summarizer: Test formatting and LLM call patterns (with mock LLM).
  - MemoryStore: Test touch(), deleteMany(), summarize() edge cases, prune() edge cases.
  - MemStack: Test health(), close().
  - ContextCompiler: Test empty input, all-recent, all-important, mixed types.
  **Verify:** All new tests pass. Coverage improves.

- [ ] 5.2 Integration tests
  **Agent:** @tester
  **Scope:** 
  - Full pipeline test: store → retrieve → compileContext → summarize → prune, verifying state at each stage.
  - Auto-summarization trigger test: store exactly 100 interactions, verify summary created.
  - Auto-prune trigger test: store memories, set pruneInterval low, verify pruning fires.
  - Export/import with all memory types (interaction, summary, observation, gossip).
  **Verify:** All integration tests pass.

- [ ] 5.3 Concurrent access tests
  **Agent:** @tester
  **Scope:** Verify MemoryStore handles concurrent store/retrieve/prune without data loss. InMemoryStorage should be safe (Map is single-threaded in Node anyway, but test concurrent promise scheduling).
  **Verify:** Tests pass without data corruption.

## Phase 6: Documentation

- [ ] 6.1 README accuracy audit
  **Agent:** @documenter
  **Scope:** Verify every code example in README compiles and runs against the actual exports. Fix any discrepancies found in Phase 2.3.
  **Verify:** Copy-paste README examples into a scratch file — TypeScript must accept them.

- [ ] 6.2 AGENTS.md completeness
  **Agent:** @documenter
  **Scope:** Verify AGENTS.md covers all conventions, commands, directory structure, known issues. Ensure it's useful for new contributors.
  **Verify:** AGENTS.md matches current state of codebase.

- [ ] 6.3 API reference accuracy
  **Agent:** @documenter
  **Scope:** Verify all types, interfaces, and method signatures in README API Reference section match source code.
  **Verify:** No missing/extra parameters in docs.

## Phase 7: Publish

- [x] 7.1 Final verification
  **Agent:** @orchestrator
  **Scope:** Run `pnpm check && pnpm test && pnpm build`. Verify dist/ contents. Verify git status is clean (committed changes).
  **Verify:** All commands exit 0. dist/ has index.js, index.mjs, index.d.ts.

- [ ] 7.2 Publish to npm
  **Agent:** @deployer
  **Scope:** `pnpm publish --access public`. Tag release `git tag v0.2.0`.
  **Verify:** `npm view @memstack/core version` returns `0.2.0`.

## Exit Criteria

- [ ] All items above marked `[x]`
- [ ] `pnpm check` exits 0
- [ ] `pnpm test` exits 0 (all tests passing, new tests added)
- [ ] `pnpm build` exits 0 and produces valid dist/
- [ ] README code examples match actual API surface
- [ ] `git status` is clean (all changes committed)
