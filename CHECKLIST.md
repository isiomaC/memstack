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

## Exit Criteria

- [ ] All items above marked `[x]`
- [ ] `pnpm check` exits 0
- [ ] `pnpm test` exits 0 (393 tests)
- [ ] `pnpm build` succeeds
- [ ] `git status` is clean (no uncommitted changes)
