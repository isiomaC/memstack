# MemStack — Orchestrator Checklist

> **PROJECT_TEST_COMMAND:** `pnpm test` (393 unit tests)  
> **PROJECT_E2E_COMMAND:** `npx vitest run --config vitest.e2e.config.ts` (82 tests, requires Docker)  
> **PROJECT_LINT_COMMAND:** `pnpm check` (tsc --noEmit)  
> **PROJECT_TYPE_CHECK_COMMAND:** `pnpm check`

Each item defines its scope, verification condition, and assignee. The orchestrator dispatches the assigned agent, then dispatches a **@reviewer** to verify the work. Items are marked `[x]` only after the reviewer reports PASS.

**Review loop:** subagent → reviewer → PASS (mark done) or FAIL (re-dispatch subagent with fixes → re-review). Max 3 retries per item before BLOCKED.

---

## Phase 1: v1.0 Ecosystem

- [ ] 1.1 `@memstack/relationships` package
  **Agent:** @implementer
  **Scope:** Entity relationship tracking as separate workspace package. Link/query relationships between memories.
  **Verify:**
  - `pnpm check` exits 0
  - `pnpm test` exits 0 in the new package

- [ ] 1.2 `@memstack/langchain` package
  **Agent:** @implementer
  **Scope:** LangChain memory provider. Implements BaseMemory and BaseStore interfaces.
  **Verify:**
  - `pnpm check` exits 0
  - `pnpm test` exits 0

- [ ] 1.3 `@memstack/ai-sdk` package
  **Agent:** @implementer
  **Scope:** Vercel AI SDK memory provider. Plugs into useChat, streamText patterns.
  **Verify:**
  - `pnpm check` exits 0
  - `pnpm test` exits 0

- [ ] 1.4 Benchmarks vs Mem0
  **Agent:** @tester
  **Scope:** Retrieval quality, latency, cost comparison against Mem0.
  **Verify:**
  - Benchmark results documented with reproducible methodology
  - Covers semantic search, summarize, compileContext scenarios

- [ ] 1.5 Python port
  **Agent:** @implementer
  **Scope:** `memstack-py` — thin HTTP client around @memstack/server. pip install memstack.
  **Verify:**
  - Client connects to running server
  - Store/retrieve round-trip works from Python

---

## Exit Criteria

- [ ] All items above marked `[x]`
- [ ] `pnpm check` exits 0
- [ ] `pnpm test` exits 0 (393 unit tests)
- [ ] `npx vitest run --config vitest.e2e.config.ts` exits 0 (82 e2e tests)
- [ ] Server integration smoke test passes (health, store→retrieve, export→import, CLI cross-process)
- [ ] MCP tools/list + tool call round-trip works
- [ ] `git status` is clean
