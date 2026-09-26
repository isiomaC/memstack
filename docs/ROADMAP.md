# MemStack Roadmap

**Status:** Canonical
**Updated:** 2026-09-26

This file owns MemStack implementation priority. The public README describes released behavior; dated plans preserve execution history.

## Implemented

- Public `@memstack/core`, `@memstack/cli`, `@memstack/mcp`, and `@memstack/server` packages at `0.7.2`.
- GitHub `v0.7.2` release, verified GHCR server image, and npm Trusted Publishing deployment.
- Deterministic unit and package suites across the supported adapters and product surfaces.
- Built-artifact, packed-package, Docker-image, and real-backend verification scripts.
- Equivalent pull-request and publication gates with a stable `verification` status check.
- A Val release scenario that evaluates an explicit target revision and preserves report and ledger evidence.
- MCP Registry metadata (`mcpName` and `server.json`) for the published MCP package.

## Next

1. Harness memory Phase 1: `memstack init` and `memstack connect claude-code|codex`, with memory shared across both harnesses per project. Decisions and build order: [ADR 0001](adr/0001-harness-first-memory.md). The release gate is the Claude Code ↔ Codex cross-harness demo.
2. Publish and verify the `@memstack/mcp` entry in the official MCP Registry.
3. Submit the verified server image and MCP metadata to Docker MCP Catalog, Smithery, and Glama.
4. Measure successful quick-start completions and fix the largest onboarding drop-off before adding adapters.

## Deferred

- Harness hooks (session-start recall, per-prompt recall, session-end capture) until harness memory Phase 1 is stable; capture also waits for the Phase 2 decision pipeline.
- OS keychain storage for the LLM API key.

- New storage, LLM, or embedding adapters without a named adopter.
- A hosted memory service before repeated OSS users request an operationally managed outcome.
