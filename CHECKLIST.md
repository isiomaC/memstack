# MemStack Checklist

Each item defines its scope, verification condition, and assignee. The orchestrator dispatches the assigned agent, then dispatches a **@reviewer** to verify the work. Items are marked `[x]` only after the reviewer reports PASS.

**Review loop:** subagent → reviewer → PASS (mark done) or FAIL (re-dispatch subagent with fixes → re-review). Max 3 retries per item before BLOCKED.

## Phase 1: Foundation

- [x] 1.1 AGENTS.md at repo root
  **Agent:** @documenter
  **Scope:** `AGENTS.md` must exist at the repo root (symlink to `docs/AGENTS.md`). Sub-agents read this on dispatch.
  **Verify:**
  - File exists at `./AGENTS.md`
  - Content matches `docs/AGENTS.md`

- [x] 1.2 GitMCP badge in README
  **Agent:** @documenter
  **Scope:** Add `https://gitmcp.io/isiomaC/memstack` badge to root README.md badge row so LLM assistants have instant reference access.
  **Verify:**
  - README badge row includes a GitMCP badge link
  - `https://gitmcp.io/isiomaC/memstack` resolves (curl follow redirects)

## Phase 2: Skills

- [x] 2.1 Skill: `memstack-cli` — `packages/skills/memstack-cli/SKILL.md`
  **Agent:** @implementer
  **Scope:** Teach LLMs to use `@memstack/cli` for persistent agent memory. Must cover:
  - What MemStack is and when to use it (2-3 sentences)
  - Installation (`npm install -g @memstack/cli`, `npx`, verify with `health`)
  - Configuration — all 8+ env vars with defaults and storage backend options
  - Command reference — all 12 commands with flags, examples, JSON output
  - Integration pattern — the memory loop: retrieve context → respond → store interaction → periodic summarize/prune
  - Best practices — importance scoring, token budget, actor ID conventions, storage backend tradeoffs
  **Verify:**
  - File exists at `packages/skills/memstack-cli/SKILL.md`
  - Covers all 12 commands
  - Covers all 8+ env vars
  - Integration pattern section is present
  - Best practices section is present

## Phase 3: Hardening & Scale

- [ ] 3.1 Wire e2e tests into CI
  **Agent:** @implementer
  **Scope:** `ci.yml` never runs the 82 e2e tests (`pnpm test:e2e`), which need real service instances (Postgres/Redis/Qdrant/Neo4j/Weaviate/MongoDB — see `docker-compose.yml` and `e2e/run-all.sh`). Add a CI job that stands these up via GitHub Actions `services:` and runs the e2e suite. This is also the mechanism for promoting the still-gated experimental adapters (Pinecone/Turso/Zep/Mem0/Upstash/Chroma — see README's Experimental table): once a real e2e run against live credentials passes in CI, uncomment that adapter's export in `src/index.ts`.
  **Verify:**
  - `ci.yml` has a job that runs `pnpm test:e2e` (or equivalent) against real service containers, not mocks
  - The job passes on a clean run
  - At least one previously-experimental adapter has a documented path (secrets + CI job) to promotion, even if not all six are promoted in this item

- [ ] 3.2 Dedupe CI job preamble
  **Agent:** @implementer
  **Scope:** All 6 `ci.yml` jobs (core, config-env, mcp, cli, server) repeat the same checkout/pnpm-setup/node-setup/core-build/config-env-build steps. Collapse this via a build matrix or a shared "build once, reuse via artifact/cache" step to cut CI time and the maintenance burden of updating N jobs every time a new shared package (like `config-env`) is added — exactly the class of bug fixed in the "fix(ci): build config-env in the core job" commit.
  **Verify:**
  - Total distinct `pnpm install` / core-build invocations across the workflow is reduced
  - All existing jobs still pass with equivalent coverage (no test silently dropped)

- [ ] 3.3 Server production hardening
  **Agent:** @implementer
  **Scope:** `packages/server/src/index.ts`'s rate limiter keys on the client-spoofable `x-forwarded-for` header (safe only behind a trusted proxy that overwrites it); the `MEMSTACK_API_KEY` bearer-token comparison uses `===` instead of a timing-safe compare (`crypto.timingSafeEqual`); there's no structured logging or request IDs, making self-hosted deployments hard to debug/audit.
  **Verify:**
  - Rate limiter either documents the trusted-proxy assumption clearly or supports a safer default (e.g. connection-level IP)
  - Bearer-token comparison uses a constant-time compare
  - Requests get a correlation/request ID surfaced in at least error responses and/or logs

- [ ] 3.4 Benchmarks suite
  **Agent:** @implementer
  **Scope:** README already lists this under "Most needed contributions." Build a benchmark harness comparing retrieval quality (precision/recall on a labeled query set) and token-cost curves across storage adapters and against Mem0/raw-vector-DB baselines, per the README's positioning ("open-source alternative to Mem0").
  **Verify:**
  - A runnable benchmark script/package exists with documented methodology
  - Results are captured somewhere referenceable from the README (even a linked doc/gist is fine for v1)

## Exit Criteria

- [ ] All items above marked `[x]`
- [ ] `pnpm check` exits 0
- [ ] `pnpm test` exits 0 (414 tests)
- [ ] `pnpm build` succeeds
- [ ] `git status` is clean (no uncommitted changes)
