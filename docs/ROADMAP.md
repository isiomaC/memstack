# MemStack Roadmap

**Status:** Canonical
**Updated:** 2026-08-04

This file owns MemStack implementation priority. The public README describes released behavior; dated plans preserve execution history.

## Implemented

- Public core, CLI, MCP, REST server, configuration, and agent-skill packages at `0.7.0`.
- Deterministic unit and package suites across the supported adapters and product surfaces.
- Built-artifact, packed-package, Docker-image, and real-backend verification scripts.
- Equivalent pull-request and publication gates with a stable `verification` status check.
- A Val release scenario that evaluates an explicit target revision and preserves report and ledger evidence.

## Next

1. Merge the verification branch and require the `verification` status check on `main`.
2. Publish the next verified package set and prove installation from npm, not the workspace.
3. Submit the existing MCP server and skill to appropriate discovery surfaces after owner credentials are available.
4. Measure successful quick-start completions and fix the largest onboarding drop-off before adding adapters.

## Deferred

- New storage, LLM, or embedding adapters without a named adopter.
- A hosted memory service before repeated OSS users request an operationally managed outcome.
