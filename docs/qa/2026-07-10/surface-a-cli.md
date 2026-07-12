# Surface A — CLI (2026-07-10)

## Setup
- Alias: `node /Users/chuck/git/memstack/packages/cli/dist/cli.js`
- Storage: disk (`/tmp/memstack-qa.HxulRC/data`)
- LLM: mock server at 127.0.0.1:4321
- `memstack health`: `{"storage":true,"llm":true,"embedding":false}` ✅

## Golden Path 3.1 (ordered) — ALL PASS

| # | Scenario | Status |
|---|----------|--------|
| 1 | store qa_alice "likes tea" | ✅ |
| 2 | store qa_alice "likes coffee too" | ✅ |
| 3 | retrieve qa_alice → 2 memories | ✅ |
| 4 | context qa_alice max-tokens 500 | ✅ |
| 5 | stats qa_alice total>=2 | ✅ |
| 6 | summarize qa_alice → MOCK_LLM_RESPONSE | ✅ |
| 7 | stats qa_alice → total=1 (summarized) | ✅ |
| 8 | purge qa_alice → 1 | ✅ |
| 9 | retrieve qa_alice → [] | ✅ |

## Golden Path 3.2 — ALL PASS

| # | Scenario | Status |
|---|----------|--------|
| 10 | store qa_bob "first" | ✅ |
| 11 | store qa_bob "second" | ✅ |
| 12 | merge ID1+ID2 → new memory | ✅ |
| 13 | delete existing id → deleted:true | ✅ |
| 14 | export → version:1, memories[] | ✅ |
| 15 | export --out → file exists | ✅ |
| 16 | import → imported:1, retrieve confirms | ✅ |
| 17 | prune --dry-run → wouldPrune array | ✅ |
| 18 | prune (no dry-run) → memories deleted | ✅ |

## Edge Cases 3.3

| # | Scenario | Status |
|---|----------|--------|
| 19 | store no --content | ✅ clean error |
| 20 | store no --actor | ✅ clean error |
| 21 | delete non-existent id | ✅ error "Memory not found" |
| 22 | merge single id | ✅ error "requires at least 2" |
| 23 | import no --file | ✅ clean error |
| 24 | import bad file path | ✅ ENOENT error |
| 25 | retrieve unknown actor | ✅ [] |
| 26 | no command | ✅ usage text |
| 27 | invalid command | ✅ usage text, exit 1 |
| 28 | importance=2 (out of range) | ❌ silently accepted |
| 29 | prune invalid strategy | ❌ silently returns 0, exit 0 |

## Improvisation 3.4

- Shell injection `$(whoami)`: ✅ literal text
- Emoji/unicode: ✅ stored correctly
- 10K char content: ✅ stored
- Trailing comma + empty tags: ⚠️ empty strings in array
- Whitespace actorId: ⚠️ not trimmed
- Concurrent stores (10): ❌ only 7 stored, disk race condition
- Negative importance: ❌ accepted (--importance=-1 → -1 stored)
- max-tokens 0: ✅ empty context

## Findings (Surface A)

1. **cross-actor prune** — `prune --actor qa_bob` pruned qa_carol's memory too. `--actor` flag not scoping prune.
2. **import overwrites createdAt** — original date replaced with current time.
3. **importance out-of-range** — accepts values outside 0–1 (2, -1).
4. **invalid prune strategy silent** — returns 0 pruned, exit 0 instead of error.
5. **disk storage concurrency** — 3 of 10 concurrent stores lost.
6. **actorId not trimmed** — leading/trailing whitespace preserved.
7. **empty tags** — trailing commas produce empty strings in tags array.

