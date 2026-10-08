// Per-command help, printed by `memstack <command> --help` and `memstack help <command>`.
// Keep in step with packages/skills/memstack-cli/REFERENCE.md.

const ACTOR = `  --actor <id>       Actor ID that groups related memories
  --project          Use this repository's project instead of --actor, the same
                     memories Claude Code and Codex see through \`memstack connect\``;

const MEMORY_ENV = `
Reads ~/.memstack/config.json (written by \`memstack init\`); environment variables
such as OPENAI_API_KEY and MEMSTACK_STORAGE override it. Prints JSON.
`;

export const COMMAND_HELP: Record<string, string> = {
  init: `memstack init [flags]

Choose an LLM provider and a store, check the key with a real request, and write
~/.memstack/config.json (readable only by you). Prompts for anything not given
as a flag; with --yes or without a terminal it uses flags and existing values.

  --provider <name>    openai-compatible (default) or anthropic
  --base-url <url>     OpenAI-compatible endpoint, e.g. https://api.deepseek.com
  --model <name>       Model override
  --api-key-env <VAR>  Read the API key from this environment variable
  --store <type>       Storage type (default: sqlite)
  --path <path>        File or directory for sqlite, disk, or markdown
  --url <url>          Connection URL for postgres, redis, or mongodb
  --yes                Don't prompt
`,

  connect: `memstack connect <claude-code|codex> [flags]

Register MemStack's MCP server with a harness, add a session-start hook that
loads the project's memories, and for Codex add a marked block to
~/.codex/AGENTS.md. Checks the server first and undoes every change if a step
fails. Safe to run again.

  --dry-run        Show what would change without changing it
  --no-hooks       Skip the session-start hook
  --no-llm         (init) Skip the LLM key; memories are saved without topic tags
  --no-agents-md   Skip the Codex AGENTS.md block
`,

  disconnect: `memstack disconnect <claude-code|codex> [flags]

Remove everything \`memstack connect\` added. Memories are kept.

  --dry-run   Show what would change without changing it
`,

  status: `memstack status

Show where configuration comes from (config file or environment variables), the
LLM and storage in use, this repository's project ID, and each harness's
connection, guidance, and session-start hook.
`,

  doctor: `memstack doctor [flags]

Check the configuration, storage driver, MCP server, and harness connections,
and print a fix for each problem. Exits non-zero when it finds any.

  --live   Also send a test request to the LLM provider
`,

  memories: `memstack memories [query] [flags]

List this repository's memories (project and global), or search them.

  --global        Only global memories
  --limit <n>     Maximum to show (default: 20)
  --delete <id>   Delete one memory
`,

  project: `memstack project [pin <id> | merge <old-id>]

  memstack project               Show this repository's project ID and where it comes from
  memstack project pin <id>      Write .memstack.json so every clone uses <id>
  memstack project merge <old>   Move memories stored under an old project ID to this one
`,

  store: `memstack store --content <text> (--actor <id> | --project) [flags]

${ACTOR}
  --content <text>   Memory text (required)
  --type <type>      interaction (default), summary, observation, fact, reflection,
                     preference, decision, or instruction
  --importance <n>   0.0 to 1.0
  --tags <a,b>       Comma-separated tags
${MEMORY_ENV}`,

  retrieve: `memstack retrieve (--actor <id> | --project) [flags]

${ACTOR}
  --query <text>          Search text
  --strategy <name>       recent (default), important, semantic, or hybrid
  --limit <n>             Default: 10
  --tags <a,b>            Only memories with these tags
  --created-after <iso>   e.g. 2026-01-01T00:00:00Z
  --created-before <iso>
${MEMORY_ENV}`,

  context: `memstack context (--actor <id> | --project) [flags]

Compile memories into a token-budgeted system prompt.

${ACTOR}
  --max-tokens <n>   Token budget (default: 2000)
${MEMORY_ENV}`,

  summarize: `memstack summarize (--actor <id> | --project) [flags]

Compress old interactions into summaries.

${ACTOR}
  --older-than <d>   Only memories older than this, e.g. 7d, 24h, 30m
${MEMORY_ENV}`,

  prune: `memstack prune (--actor <id> | --project) [flags]

${ACTOR}
  --type <name>            byAge (default), byImportance, or byCount
  --max-age <d>            For byAge, e.g. 30d
  --min-importance <n>     For byImportance
  --max-count <n>          For byCount: keep the top n
  --dry-run                Show what would be removed
${MEMORY_ENV}`,

  purge: `memstack purge (--actor <id> | --project)

Delete every memory for the actor.

${ACTOR}
${MEMORY_ENV}`,

  merge: `memstack merge --ids <id,id,...>

Merge several memories into one.
${MEMORY_ENV}`,

  stats: `memstack stats [--actor <id> | --project]

Memory counts and diagnostics; all actors when neither flag is given.
${MEMORY_ENV}`,

  delete: `memstack delete --id <id>
${MEMORY_ENV}`,

  health: `memstack health

Check storage, LLM, and embedding connectivity.
${MEMORY_ENV}`,

  export: `memstack export [--actor <id> | --project] [--out <file>]

Export memories as a JSON snapshot; all actors when neither flag is given.
${MEMORY_ENV}`,

  import: `memstack import (--actor <id> | --project) --file <file>

Import memories from a JSON snapshot.

${ACTOR}
  --file <file>   Snapshot path (required)
${MEMORY_ENV}`,
};
