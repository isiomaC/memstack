# MemStack Manual QA Runbook — Instructions for an LLM Agent

You are a manual QA tester. You have shell access. Your job is to use MemStack
the way a real developer would — running real commands, reading real output —
and report anything that is broken, confusing, or surprising. You are NOT
writing or running automated test files. You are NOT reading the source code
to check "does this look right." You judge correctness ONLY from what the
running program actually outputs, compared against what this document tells
you to expect.

Read this entire document before running anything.

---

## 0. Mission and definition of done

MemStack has five things worth testing:

- **A. CLI** (`@memstack/cli`) — a command-line tool, 12 commands.
- **B. MCP server** (`@memstack/mcp`) — a background process other AI tools talk to, 18 tools.
- **C. REST server** (`@memstack/server`) — an HTTP API, 15+ endpoints.
- **D. Docker image** — the REST server, pre-built and published to a container registry.
- **E. Core library adapters with no product surface** — `@memstack/core` has
  18 storage adapters, 4 LLM adapters, and 2 embedding adapters, but A–D can
  only ever reach a subset of them (the ones wired up by environment
  variables). Section 7 covers testing the rest directly.

**Important:** A, B, C, and D all sit on top of the same underlying library
(`@memstack/core`) through a shared env-var-driven config layer
(`@memstack/config-env`). That layer only knows how to build 6 of the 18
storage adapters (`memory`, `disk`, `markdown`, `postgres`, `sqlite`,
`redis`), 2 of the 4 LLM adapters (OpenAI, Anthropic), and 1 of the 2
embedding adapters (OpenAI). No matter how thoroughly you test A–D, you will
**never** exercise the other 11 storage adapters, the Groq/Ollama LLM
adapters, or the Cohere embedding adapter that way — there is no env var
combination that selects them. That's what Section 7 (Surface E) is for.
Testing A–D thoroughly does NOT mean "the core package is covered" — it means
"the memory pipeline and these specific 6/2/1 adapters are covered."

For each surface you are asked to test, you will:

1. Set it up (exact steps given below — do not improvise setup).
2. Run every "golden path" scenario listed and confirm the output matches what's described.
3. Run every "edge case" scenario listed and confirm the output matches what's described.
4. Spend a fixed amount of extra time (stated per surface) trying things NOT
   listed here — unusual input, things a curious/impatient user might do. This
   is the "as a human would test it" part. Section 9 gives you a menu of ideas.
5. Record every deviation from expected behavior using the Bug Report format
   in Section 10. If nothing goes wrong for a scenario, do not write anything
   for it — only report deviations.
6. Tear down cleanly (kill background processes you started, delete temp
   directories you created).
7. Produce ONE final message using the Session Summary format in Section 11.

**You are done with a surface when** every golden path and edge case scenario
listed for it has been run at least once, AND you've spent the stated
improvisation time on it, AND you've produced a Session Summary for it.

---

## 1. Ground rules (do not violate these)

- **Never edit any file under `src/`, `packages/*/src/`, or any `.ts`/`.js`
  source file.** You are testing the built product as-is. If something seems
  broken, that is a finding to report, not something for you to fix.
- **Never run `git commit`, `git push`, or modify git history.** You may
  freely create files inside temp directories (see below).
- **Never delete or modify anything outside of directories you created
  yourself for this test session.**
- **All test data must use actor IDs prefixed with `qa_`** (e.g. `qa_alice`,
  `qa_smoketest_1`) so it's obviously test data and never collides with real
  data, and so cleanup (e.g. `purge`) is unambiguous.
- **All test data directories must live under a single temp root you create
  at the start** (Section 2, step 2) so teardown is one `rm -rf`.
- **Never use real API keys.** Every scenario below is designed to work with
  a fake key (`sk-test`) and a local mock LLM server (Section 2, step 4). If a
  scenario seems to require a real OpenAI/Anthropic account, stop and report
  that as a finding instead of going to find real credentials.
- **Kill every background process you start.** Before you finish a surface,
  run `ps aux | grep -E "memstack|mock-llm|node dist"` and confirm nothing
  from this session is still running.
- If a command hangs for more than 20 seconds with no output, kill it
  (Ctrl+C / `kill`) and report it as a finding (Section 10) — do not wait
  indefinitely.

---

## 2. One-time environment setup

Run these once, in order, before testing any surface. Do not skip steps or
reorder them — later steps depend on earlier ones.

**Step 1 — Confirm you're in the repo root and install dependencies.**

```bash
pwd   # should print .../memstack (the repo root — has package.json, pnpm-workspace.yaml)
pnpm install
```

Expected: exits with code 0, no `ERR_` lines. If it fails, stop and report a
finding — nothing else in this document will work.

**Step 2 — Create your temp root and export it as a variable.**

```bash
export QA_ROOT=$(mktemp -d /tmp/memstack-qa.XXXXXX)
echo $QA_ROOT
```

Keep this shell session open for your whole run — `$QA_ROOT` is reused
everywhere below. If your shell tool does not persist environment variables
between commands, write the value down and substitute it literally every
time you see `$QA_ROOT` below.

**Step 3 — Build the packages you'll need.** This project is a pnpm
workspace; the core package and the shared config package must be built
before any of the sub-packages (cli/mcp/server) will run.

```bash
npx tsup src/index.ts --format cjs,esm --dts --clean
cd packages/config-env && npx tsup src/index.ts --format cjs,esm --dts --clean && cd ../..
```

Expected: both print `Build success`. If either fails, stop — report a
finding, do not proceed to build the sub-packages.

**Step 4 — Start the local mock LLM server.** Every LLM-touching command
(`summarize`, `health`, any MCP tool that calls the LLM) needs *something* to
answer HTTP requests at `/chat/completions` — it doesn't need to be smart,
it just needs to reply with valid JSON so you can test everything else
without a real API key or network access. Write this file:

`$QA_ROOT/mock-llm.js`:
```js
const http = require('http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'MOCK_LLM_RESPONSE' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
});
server.listen(4321, '127.0.0.1', () => console.error('mock-llm listening on 4321'));
```

Then start it in the background and confirm it's up:

```bash
node $QA_ROOT/mock-llm.js > $QA_ROOT/mock-llm.log 2>&1 &
echo "mock LLM PID: $!"
sleep 1
curl -s -X POST http://127.0.0.1:4321/chat/completions -d '{}' | head -c 200
```

Expected: the curl prints JSON containing `"MOCK_LLM_RESPONSE"`. If it
doesn't, stop and report a finding before continuing — nothing that touches
the LLM will work otherwise.

**Step 5 — Define the standard environment for every command you run below.**
Write this to a file so you can source it instead of retyping it:

`$QA_ROOT/env.sh`:
```bash
export MEMSTACK_STORAGE=disk
export MEMSTACK_DIR=$QA_ROOT/data
export MEMSTACK_EMBED_ON_STORE=false
export OPENAI_API_KEY=sk-test
export MEMSTACK_OPENAI_BASE_URL=http://127.0.0.1:4321
```

Then: `source $QA_ROOT/env.sh` and `mkdir -p $MEMSTACK_DIR`.

Why these values: `disk` storage persists between separate command
invocations (unlike `memory`, which resets every time you run a new
process) so you can store something in one command and retrieve it in the
next, like a real user would. `MEMSTACK_EMBED_ON_STORE=false` avoids needing
a mock embeddings endpoint too. Pointing `MEMSTACK_OPENAI_BASE_URL` at the
mock server means the OpenAI adapter code path really runs (real HTTP
request/response), just against a stand-in server instead of the internet.

You're now ready to test any surface. Each surface below assumes Steps 1–5
are done.

---

## 3. Surface A — CLI (`@memstack/cli`)

**Setup for this surface:**
```bash
cd packages/cli
npx tsup src/cli.ts --format esm --clean
cd ../..
alias memstack="node $PWD/packages/cli/dist/cli.js"
```
Confirm: `source $QA_ROOT/env.sh && memstack health` should print JSON with
`"storage": true` and `"llm": true`. If `llm` is `false`, stop — your mock
server or env vars are wrong; fix before continuing.

### 3.1 Golden path — run these in order, they build on each other

| # | Command | Expect |
|---|---|---|
| 1 | `memstack store --actor qa_alice --content "likes tea" --importance 0.8 --tags pref,drink` | JSON with an `id` starting `mem_`, `actorId: "qa_alice"`, `content: "likes tea"`, `tags: ["pref","drink"]` |
| 2 | `memstack store --actor qa_alice --content "likes coffee too"` | Another JSON memory object, different `id` |
| 3 | `memstack retrieve --actor qa_alice` | A JSON **array** containing both memories from steps 1–2 |
| 4 | `memstack context --actor qa_alice --max-tokens 500` | JSON object with a `systemPrompt` string, a `recentMemories` array, a numeric `tokenEstimate` |
| 5 | `memstack stats --actor qa_alice` | JSON with `total` >= 2 |
| 6 | `memstack summarize --actor qa_alice` | JSON with `summary.content` equal to `"MOCK_LLM_RESPONSE"` and a numeric `deletedCount` |
| 7 | `memstack stats --actor qa_alice` | `total` should now be lower than step 5's (summarize replaced originals with one summary memory) |
| 8 | `memstack purge --actor qa_alice` | A plain number (count of deleted memories), >= 1 |
| 9 | `memstack retrieve --actor qa_alice` | An empty JSON array `[]` |

### 3.2 Golden path — the rest of the commands (independent of above)

| # | Command | Expect |
|---|---|---|
| 10 | `memstack store --actor qa_bob --content "first"` then capture its `id` as `$ID1` | as above |
| 11 | `memstack store --actor qa_bob --content "second"` then capture its `id` as `$ID2` | as above |
| 12 | `memstack merge --ids "$ID1,$ID2"` | JSON single memory object, `actorId: "qa_bob"`, new `id` |
| 13 | `memstack delete --id <any existing id>` | `{"deleted": true}` |
| 14 | `memstack export` | JSON with `version: 1` and a `memories` array |
| 15 | `memstack export --out $QA_ROOT/snap.json` | JSON `{"saved": "<path>", "count": <number>}`, and the file must actually exist: `cat $QA_ROOT/snap.json` should show the same snapshot |
| 16 | Write a minimal snapshot file by hand (see below), then `memstack import --actor qa_carol --file $QA_ROOT/import.json` | `{"imported": 1}`, and `memstack retrieve --actor qa_carol` should show it |
| 17 | `memstack prune --actor qa_bob --type byImportance --min-importance 0.9 --dry-run` | JSON with `wouldPrune` array and `count`; running `retrieve --actor qa_bob` right after must show NOTHING was actually deleted |
| 18 | Same command without `--dry-run` | Now memories ARE actually deleted; confirm with `retrieve` |

Minimal import file for step 16, write to `$QA_ROOT/import.json`:
```json
{
  "version": 1,
  "memories": [{
    "id": "mem_qa_import_1",
    "actorId": "qa_carol",
    "content": "imported test memory",
    "memoryType": "interaction",
    "importance": 0.5,
    "emotionalValence": 0,
    "tags": [],
    "createdAt": "2026-01-01T00:00:00.000Z"
  }],
  "exportedAt": "2026-01-01T00:00:00.000Z"
}
```

### 3.3 Edge cases — every command should fail *cleanly*, not crash

A "clean failure" means: non-zero exit code, a short human-readable error
message on stderr (not a raw stack trace / `TypeError` / `undefined is not a
function`), and stdout stays empty or unaffected.

| # | Command | Expect |
|---|---|---|
| 19 | `memstack store --actor qa_x` (no `--content`) | Clean failure mentioning `--content` |
| 20 | `memstack store --content "hi"` (no `--actor`) | Clean failure mentioning `--actor` |
| 21 | `memstack delete --id mem_does_not_exist` | Check: does it error, or silently report `{"deleted": true}` for an ID that never existed? Either way, report which one it does — this is worth knowing even if it's not necessarily "wrong". |
| 22 | `memstack merge --ids "mem_onlyone"` | Clean failure — merge needs at least 2 |
| 23 | `memstack import --actor qa_x` (no `--file`) | Clean failure mentioning `--file` |
| 24 | `memstack import --actor qa_x --file /path/does/not/exist.json` | Clean failure (not a raw Node stack trace) |
| 25 | `memstack retrieve --actor qa_nobody_has_this_actor` | Empty array `[]`, not an error |
| 26 | `memstack` (no command at all) | Prints usage/help text, non-zero exit |
| 27 | `memstack this-is-not-a-real-command` | Prints usage/help text, non-zero exit |
| 28 | `memstack store --actor qa_edge --content "x" --importance 2` (out of the presumed 0–1 range) | Does it reject this, clamp it, or silently accept an out-of-range value? Report what actually happens. |
| 29 | `memstack prune --actor qa_edge --type totally-invalid-strategy` | Clean failure, not a crash |

### 3.4 Improvise (spend ~15 minutes here)

Try things not listed above. Ideas: extremely long `--content` (10,000+
characters), content with emoji/unicode/newlines, content that looks like a
shell injection attempt (e.g. `--content "$(whoami)"` — it should be treated
as literal text, not executed), duplicate `--actor` flags, flags in random
order, `--tags` with empty string or trailing commas, storing 50 memories for
one actor in a loop then retrieving to see if anything breaks at volume,
running two `memstack store` commands for the same actor at the exact same
time (background both with `&`) to see if disk storage handles concurrent
writes.

---

## 4. Surface B — MCP server (`@memstack/mcp`)

**Setup for this surface** — use the official MCP Inspector, the standard
tool for interactively testing any MCP server:

```bash
cd packages/mcp
npx tsup src/index.ts src/cli.ts --format esm --dts --clean
cd ../..
source $QA_ROOT/env.sh
npx -y @modelcontextprotocol/inspector node packages/mcp/dist/cli.js
```

This opens a local web UI (the terminal output will print a URL, typically
`http://localhost:6274` — read the actual printed URL, it may include a
session token in the query string). If you cannot open a browser, run
`npx -y @modelcontextprotocol/inspector --cli node packages/mcp/dist/cli.js --method tools/list`
instead — check `npx -y @modelcontextprotocol/inspector --cli --help` for the
exact non-interactive flags available in the installed version, since this
can change between versions.

### 4.1 Golden path

1. List tools. Expect exactly 18 tools whose names all start with `memory_`
   (e.g. `memory_store`, `memory_retrieve`, `memory_get`, `memory_store_batch`,
   `memory_compile_context`, `memory_summarize`, `memory_prune`,
   `memory_dry_run_prune`, `memory_purge_actor`, `memory_merge`,
   `memory_stats`, `memory_delete`, `memory_delete_many`, `memory_touch`,
   `memory_export`, `memory_import`, `memory_health`, `memory_process`).
2. Call `memory_store` with `{"content": "qa mcp test", "actorId": "qa_mcp_1"}`.
   Expect a memory object with an `id` back, no error.
3. Call `memory_retrieve` with `{"actorId": "qa_mcp_1"}`. Expect an array
   containing the memory from step 2.
4. Call `memory_get` with `{"id": "<the id from step 2>"}`. Expect that same
   memory back.
5. Call `memory_get` with `{"id": "mem_totally_made_up"}`. Expect `null`, not
   an error.
6. Call `memory_health`. Expect `{"storage": true, "llm": true, "embedding": false}`.
7. List resources. Expect 2 resources. Read each one and confirm it returns
   content without erroring.
8. List prompts. Expect 1 prompt. Fetch it and confirm it returns without
   erroring.

### 4.2 Edge cases

- Call `memory_store` with an empty arguments object `{}` (no `content`).
  Expect a clean tool-call error, not a crash of the whole Inspector/server
  connection.
- Call `memory_merge` with only one id in the array. Expect a clean error.
- Call `memory_delete_many` with an empty `ids` array. Report what happens
  (error vs. `{"deleted": 0}`).
- Call a tool name that doesn't exist, e.g. `memory_teleport`. Expect a
  clean "unknown tool" error, and confirm the server is still alive
  afterward (call `memory_health` again to check).

### 4.3 Improvise (spend ~10 minutes here)

Try calling tools with wrong argument types (e.g. `memory_store` with
`content: 12345` instead of a string, or `tags: "not-an-array"`). Try calling
`memory_import` with a snapshot containing 0 memories. Try rapid-fire calling
the same tool 10 times in a row. If the Inspector lets you inspect raw
JSON-RPC traffic, glance at whether error responses follow a consistent
shape across different tools.

---

## 5. Surface C — REST server (`@memstack/server`)

**Setup for this surface:**
```bash
cd packages/server
npx tsup src/index.ts src/serve.ts --format esm --dts --clean
source $QA_ROOT/env.sh
PORT=5599 node dist/serve.js > $QA_ROOT/server.log 2>&1 &
echo "server PID: $!"
sleep 2
curl -s http://localhost:5599/health
cd ../..
```
Expect the curl to print `{"status":"ok", ...}`. If not, check
`$QA_ROOT/server.log` before continuing.

Define a helper you'll reuse: every request below is against
`http://localhost:5599`.

### 5.1 Golden path

| # | Request | Expect |
|---|---|---|
| 1 | `curl -s http://localhost:5599/openapi.json` | JSON with `"openapi": "3.1.0"` and a `paths` object listing all the endpoints below |
| 2 | `POST /v1/memories` `{"actorId":"qa_rest_1","content":"hello","importance":0.8}` | 201, body has `id` starting `mem_` |
| 3 | `GET /v1/memories/<id from step 2>` | 200, `content` matches |
| 4 | `POST /v1/memories/retrieve` `{"actorId":"qa_rest_1"}` | 200, array with >=1 item |
| 5 | `POST /v1/memories/context` `{"actorId":"qa_rest_1","maxTokens":500}` | 200, body has `context` |
| 6 | `POST /v1/memories/process` `{"actorId":"qa_rest_1","content":"auto-enriched"}` | 201, body has `memory.id` |
| 7 | `GET /v1/memories/count?actorId=qa_rest_1` | 200, `count` >= 2 |
| 8 | `POST /v1/memories/<id>/touch` | 200, `{"touched": true}` |
| 9 | `GET /v1/stats/qa_rest_1` | 200 |
| 10 | `POST /v1/memories/delete-many` `{"ids":["<id1>","<id2>"]}` | 200, `{"deleted": 2}` |
| 11 | `DELETE /v1/memories/<some remaining id>` | 200, `{"deleted": true}` |
| 12 | `POST /v1/prune/dry-run` `{"type":"byAge","maxAge":86400}` | 200, has a `count` |

For every `POST`/`DELETE` above, remember to pass
`-H "Content-Type: application/json"` and `-d '<json>'`.

### 5.2 Edge cases

| # | Request | Expect |
|---|---|---|
| 13 | `GET /v1/memories/does-not-exist` | 404 |
| 14 | `POST /v1/memories` with `{"actorId":"qa_rest_2"}` (no `content`) | 400, body has `"error": "Validation failed"` and a non-empty `issues` array |
| 15 | `POST /v1/memories` with `{"actorId":"qa_rest_2","content":"x","importance":5}` | 400 (importance out of 0–1 range) |
| 16 | `POST /v1/prune/dry-run` `{"type":"custom"}` | 400 (custom strategy isn't supported over REST — requires a JS function) |
| 17 | `POST /v1/memories` with a malformed body (not valid JSON at all, e.g. `-d 'not json'`) | 400, not a 500 or a raw crash |
| 18 | `GET /v1/nonexistent-route-entirely` | 404 |

### 5.3 Improvise (spend ~10 minutes here)

Try sending a request with no `Content-Type` header. Try an extremely large
`content` payload (a few hundred KB) and see if there's a size limit and
whether it's enforced cleanly (400/413) vs. crashing the process. Try
hitting the same endpoint 20 times rapidly back-to-back to see if
`MEMSTACK_RATE_LIMIT` behavior (if enabled) kicks in — note it's disabled by
default so this may be a no-op, which is fine to note. Try authenticated
routes without setting `MEMSTACK_API_KEY` at all (should just work, since
auth is opt-in) vs. setting `MEMSTACK_API_KEY` and then hitting the API
without the header (should then reject).

**Teardown:** `kill %1` or `kill <the PID you echoed above>` to stop the server.

---

## 6. Surface D — Docker/GHCR image

This surface has never been tested by anyone before — take extra care and
report anything odd, even things that seem minor.

**Setup:**
```bash
docker pull ghcr.io/isiomac/memstack-server:v0.6.4
docker run -d --name memstack-qa -p 5588:3000 \
  -e MEMSTACK_STORAGE=memory \
  -e OPENAI_API_KEY=sk-test \
  -e MEMSTACK_OPENAI_BASE_URL=http://host.docker.internal:4321 \
  ghcr.io/isiomac/memstack-server:v0.6.4
sleep 3
docker logs memstack-qa
curl -s http://localhost:5588/health
```

Note: `host.docker.internal` lets the container reach the mock LLM server
running on your host machine from Section 2 Step 4. If that hostname doesn't
resolve (Linux Docker sometimes needs `--add-host=host.docker.internal:host-gateway`
added to the `docker run` command), report that as a finding — it's exactly
the kind of deployment friction this surface is supposed to catch.

If the container fails to start or `/health` doesn't respond, that alone is
an important finding — this is the artifact that gets deployed, so any
problem here is high severity. Capture `docker logs memstack-qa` in full as
part of your bug report.

### 6.1 Golden path

Repeat scenarios 2–5 from Section 5.1 (REST golden path) against
`http://localhost:5588` instead of `5599`. This confirms the containerized
build behaves the same as the locally-built server.

### 6.2 Teardown
```bash
docker stop memstack-qa && docker rm memstack-qa
```

---

## 7. Surface E — Core library adapters with no product surface

Everything in Sections 3–6 goes through `@memstack/config-env`, which only
knows how to build 6 storage adapters, 2 LLM adapters, and 1 embedding
adapter (see Section 0). The other 11 storage adapters, Groq, Ollama, and
Cohere are real code in `@memstack/core` that nothing you've tested so far
ever calls. Testing them means writing a tiny throwaway script that imports
`@memstack/core` directly, the same way a developer embedding MemStack in
their own app would — not `memstack` the CLI, not an HTTP call, just Node
code.

**Split this into what's actually achievable without real credentials, and
what isn't.** Full setup details (docker commands, npm packages, connection
shapes) for every one of these are in **Appendix A** at the end of this
document — this table is just the scope decision:

| Adapter | In scope for you? |
|---|---|
| `HybridStorageAdapter` | Yes — no external dependency at all |
| `SQLiteStorageAdapter` | Yes |
| `LanceDBStorageAdapter` | Yes |
| `PostgresStorageAdapter` | Yes (docker) |
| `RedisStorageAdapter` | Yes (docker) — also already covered via `MEMSTACK_STORAGE=redis` in Section 3's CLI path, so testing it directly here isn't required, just allowed |
| `QdrantStorageAdapter` | Yes (docker) |
| `Neo4jStorageAdapter` | Yes (docker) |
| `WeaviateStorageAdapter` | Yes (docker) |
| `MongoDBStorageAdapter` | Yes (docker) |
| `ChromaStorageAdapter` | Yes, if you can pull `chromadb/chroma` yourself (not in this repo's compose file) |
| `TursoStorageAdapter` | Yes — has a fully local mode, no cloud account needed (see Appendix A) |
| `PineconeStorageAdapter` | **No — skip, report as "untestable without credentials"** (no local/self-hosted option exists at all) |
| `UpstashStorageAdapter` | **No — skip** (Upstash is REST-only, no official local emulator) |
| `Mem0StorageAdapter` | **No — skip by default.** It technically has a self-hostable `oss` mode, but that mode itself needs its own vector store configured — treat as out of scope unless you're told otherwise |
| `ZepStorageAdapter` | **No — skip by default.** Same situation: it has a self-hostable `community` mode, but that needs Zep's own separate server running — treat as out of scope unless you're told otherwise |
| `GroqLLMAdapter` | Yes — redirect via the mock LLM server (Groq's adapter also takes a `baseURL`) |
| `OllamaLLMAdapter` | Yes (via mock server); optional if you have real Ollama installed and want to test that instead |
| `CohereEmbeddingAdapter` | Yes — redirect via mock server the same way |

For every "No — skip" adapter, don't attempt workarounds (no fake
credentials, no trying to hit the real cloud API with a made-up key to see
what error comes back) — just note in your Session Summary that these are
out of scope for a credential-less run and remain covered only by the
repo's existing mocked unit tests (`test/pinecone-storage.test.ts`,
`test/upstash-storage.test.ts`, `test/mem0-storage.test.ts`,
`test/zep-storage.test.ts`, `test/turso-storage.test.ts`).

### 7.1 The general pattern

For each in-scope adapter, write and run a script like this (this exact one
tests `HybridStorageAdapter`, the simplest case — adapt the constructor call
for whichever adapter you're testing that round):

```bash
cat > $QA_ROOT/test-adapter.mjs << 'EOF'
import { HybridStorageAdapter, InMemoryStorageAdapter } from "/home/user/memstack/dist/index.js";

const cache = new InMemoryStorageAdapter();
const durable = new InMemoryStorageAdapter();
const adapter = new HybridStorageAdapter({ cache, durable });

const stored = await adapter.store({ actorId: "qa_core_1", content: "hello from core" });
console.log("STORED:", JSON.stringify(stored));

const fetched = await adapter.get(stored.id);
console.log("FETCHED:", JSON.stringify(fetched));

const retrieved = await adapter.retrieve({ actorId: "qa_core_1" });
console.log("RETRIEVED COUNT:", retrieved.length);

const deleted = await adapter.delete(stored.id);
console.log("DELETED:", deleted);
EOF
node $QA_ROOT/test-adapter.mjs
```

Expect: a memory object printed for STORED, the same content printed for
FETCHED, `RETRIEVED COUNT: 1`, and `DELETED: true`. That's the golden path —
call `store`, `get`, `retrieve`, `delete` on the adapter directly (these four
methods exist on every storage adapter) and confirm each returns something
sane. For docker-backed adapters, replace the constructor with the real
connection (check the matching file in `e2e/*.e2e.ts` in the repo for the
exact constructor shape and connection env vars each adapter expects — e.g.
`e2e/qdrant.e2e.ts` shows exactly how to construct `QdrantStorageAdapter`
against a local Qdrant container). Bring the docker service up first with
`docker compose -f /home/user/memstack/docker-compose.yml up -d <service>`
and tear it down after with `docker compose -f /home/user/memstack/docker-compose.yml down`.

For Groq/Ollama/Cohere, same pattern but call `.complete({system, user})` (LLM
adapters) or `.embed([...])` (Cohere) instead of the storage methods, with
`baseURL` pointed at the mock LLM server from Section 2 Step 4.

### 7.2 Edge cases (apply to whichever adapters you test)

- `get()` on an ID that was never stored — expect `null`, not a thrown error.
- `delete()` on an ID that was never stored — check what it returns (some
  adapters return `false`, some don't error either way) and just report which.
- `retrieve()` for an actor with zero memories — expect an empty array.
- Store, then immediately delete, then `retrieve` — confirm it's actually
  gone (not just excluded from the delete's own return value).

---

## 8. Storage-backend sanity check (optional, cross-cutting)

Everything above uses `MEMSTACK_STORAGE=disk`. If you have time left after
finishing A–D, repeat just the CLI golden path (Section 3.1, steps 1–3 only)
once with `MEMSTACK_STORAGE=memory` and once with `MEMSTACK_STORAGE=markdown`
(set `MEMSTACK_DIR` to a fresh temp dir for markdown). This checks that
switching backends doesn't change command *behavior*, only persistence.
Report anything that differs between backends beyond persistence.

---

## 9. General improvisation ideas (applies across all surfaces)

If you finish a surface's checklist early and still have improvisation time
budgeted, pull from this list instead of stopping:

- What happens if you interrupt a command mid-write (Ctrl+C during `store`)
  and then retrieve — is the store atomic (all-or-nothing) or can you end up
  with partial/corrupt data?
- Store a memory, then manually edit the underlying storage file/directory
  (for `disk`/`markdown` backends) to corrupt it slightly, then retrieve —
  does it fail cleanly or crash?
- Case sensitivity: does `--actor QA_Alice` collide with `--actor qa_alice`
  or are they treated as different actors?
- Whitespace: does `--actor "  qa_spacey  "` (leading/trailing spaces) get
  trimmed or stored literally?
- Very small/zero values: `--importance 0`, `--max-tokens 0`, `--limit 0`.
- Negative numbers where none are expected: `--importance -1`, `--max-age -100`.

---

## 10. Bug report format

For every deviation from expected behavior, add ONE entry in this exact
shape. Do not narrate your reasoning — just fill in the fields.

```
### [SURFACE] short title of the problem
- Severity: crash | wrong-output | confusing-but-works | docs-mismatch
- Steps to reproduce:
  1. <exact command/request, verbatim, copy-pasteable>
  2. <next step if any>
- Expected: <what this document said should happen>
- Actual: <what actually happened — paste the real output, not a paraphrase>
```

Severity guide:
- **crash** — process died, raw stack trace, connection dropped
- **wrong-output** — exited cleanly but the data/shape is incorrect
- **confusing-but-works** — technically correct but a real user would be
  surprised or misled (e.g. silent no-op, unclear error message)
- **docs-mismatch** — behavior contradicts what a README/SKILL.md said

---

## 11. Session summary format

End your run with exactly one message in this shape:

```
## MemStack QA session — [date]

Surfaces tested: [list]
Scenarios run: [total count] golden path, [total count] edge case, [minutes] improvised

### Findings
[all Section 10 entries, most severe first — or "None found" if genuinely clean]

### Environment notes
[anything about setup that was harder than this document implied — e.g. a
command in Section 2 that needed a tweak to work on your machine]

### Teardown confirmation
[confirm: no background processes left running, all temp dirs removed,
docker container stopped/removed if Section 6 was run]
```

---

## Appendix A — Storage adapter prerequisites (all 18)

Two different construction patterns exist across these adapters, and it
changes what "prerequisite" means:

- **Bring-your-own-client adapters** — the adapter's constructor takes an
  already-constructed client/index object (e.g. a `pg.Pool`, a
  `QdrantClient`). You import the vendor SDK yourself, construct the client,
  and hand it to the adapter. The adapter itself never imports that SDK.
- **Self-managing adapters** — the adapter dynamically imports the vendor
  SDK internally at runtime. You only supply config values (URL, token,
  API key); the adapter does the client construction. This is `Upstash`,
  `Mem0`, and `Zep` only.

| Adapter | Pattern | Backend needed | Local / self-hosted option | npm package required | Connection details |
|---|---|---|---|---|---|
| `InMemoryStorageAdapter` | n/a | none | always available | none | no config |
| `DiskStorageAdapter` | n/a | local filesystem | always available | none | `{ storageDir: "<path>" }` |
| `MarkdownStorageAdapter` | n/a | local filesystem | always available | none | `{ dir: "<path>" }` |
| `HybridStorageAdapter` | n/a | two other `StorageProvider` instances (cache + durable) | always available (e.g. compose two `InMemoryStorageAdapter`s) | none | `{ cache, durable }` |
| `LanceDBStorageAdapter` | bring-your-own-client | embedded, on-disk vector DB — no server process | always available | `vectordb` (already a devDependency here) | `lancedb.connect("<local path>")`, then `{ connection, tableName }` |
| `SQLiteStorageAdapter` | bring-your-own-client | local file or `:memory:` | always available once the package is installed | `better-sqlite3` (already a devDependency here — native binding, must compile on install) | `new Database("<path or :memory:>")`, then `{ db }` |
| `TursoStorageAdapter` | bring-your-own-client | libSQL — can run fully local/embedded, no cloud account required | yes, via a local file/`:memory:` client | `@libsql/client` (**not installed in this repo** — `npm install @libsql/client` first) | `createClient({ url: "file:local.db" })`, then `{ client }` |
| `PostgresStorageAdapter` | bring-your-own-client | PostgreSQL with pgvector | `docker compose up -d postgres` (repo's `docker-compose.yml`, `pgvector/pgvector:pg17` image) | `pg` (already a devDependency) | `postgres://memstack:memstack@localhost:5433/memstack` (port via `PG_PORT`, default 5433) |
| `RedisStorageAdapter` | bring-your-own-client | Redis Stack (needs the search module, plain Redis isn't enough) | `docker compose up -d redis` (`redis/redis-stack-server` image) | `ioredis` (already a devDependency) | `redis://localhost:6380` (port via `REDIS_PORT`, default 6380) |
| `QdrantStorageAdapter` | bring-your-own-client | Qdrant | `docker compose up -d qdrant` | `@qdrant/js-client-rest` (already a devDependency) | `http://localhost:6333` (port via `QDRANT_PORT`) |
| `Neo4jStorageAdapter` | bring-your-own-client | Neo4j | `docker compose up -d neo4j` | `neo4j-driver` (already a devDependency) | `bolt://localhost:7687`, user `neo4j`, password `memstack123` (all overridable via `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD`) |
| `WeaviateStorageAdapter` | bring-your-own-client | Weaviate | `docker compose up -d weaviate` | `weaviate-client` (already a devDependency) | HTTP `localhost:8080`, gRPC `localhost:50051` (`WEAVIATE_HOST`/`WEAVIATE_PORT`/`WEAVIATE_GRPC_PORT`) |
| `MongoDBStorageAdapter` | bring-your-own-client | MongoDB | `docker compose up -d mongodb` | `mongodb` (already a devDependency) | `mongodb://localhost:27017` |
| `ChromaStorageAdapter` | bring-your-own-client | a running Chroma server | **not in this repo's `docker-compose.yml`** — stand it up yourself: `docker run -d -p 8000:8000 chromadb/chroma` | `chromadb` (already a devDependency) | `new ChromaClient()` defaults to `http://localhost:8000` |
| `PineconeStorageAdapter` | bring-your-own-client | Pinecone | **none — cloud service only, no self-hosted or embedded option exists** | `@pinecone-database/pinecone` (**not installed** — would need `npm install`) | a real Pinecone project, API key, and index |
| `UpstashStorageAdapter` | self-managing (adapter imports the SDK itself) | Upstash Redis or Upstash Vector, both REST-based | **none — Upstash has no official local emulator** | `@upstash/redis` and/or `@upstash/vector` (**not installed**) | a real Upstash database's REST `url` + `token` |
| `Mem0StorageAdapter` | self-managing | `cloud` mode: Mem0's hosted API. `oss` mode: fully self-hosted, but requires you to separately configure and stand up its own vector store/LLM/embedder | `oss` mode is *theoretically* self-hostable but is itself another multi-dependency setup — treat as out of scope by default (see Section 7) | `mem0ai` (**not installed**) | `cloud`: `{ mode: "cloud", apiKey }`. `oss`: `{ mode: "oss", vectorStore, llm, embedder }` |
| `ZepStorageAdapter` | self-managing | `cloud` mode: Zep Cloud's hosted API. `community` mode: Zep's own self-hosted server (a separate project/docker-compose you'd have to bring in) | `community` mode exists but needs Zep's separate server running — treat as out of scope by default (see Section 7) | `@getzep/zep-cloud` (**not installed**) | `cloud`: `{ mode: "cloud", apiKey }`. `community`: `{ mode: "community", baseUrl }` |

Notes:
- "Already a devDependency" packages are already installed in this repo's
  `node_modules` — nothing to install, just `import` them in your throwaway
  script (Section 7.1).
- "Not installed" packages are genuinely absent from this repo (confirmed by
  checking `package.json`/`node_modules` directly) — the adapter code
  supports them, but nobody has ever actually run it against the real SDK in
  this repo. If you do install one to test it, that's worth calling out in
  your Session Summary as new ground, not just a routine pass/fail.
- Every docker-backed row uses `docker compose -f docker-compose.yml up -d <service>`
  from the repo root, and `docker compose -f docker-compose.yml down` to tear down.
