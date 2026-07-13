# MCP Setup Guide

`@memstack/mcp` is an [MCP](https://modelcontextprotocol.io) **server** — a small process that speaks the Model Context Protocol over stdio. Any MCP-compatible client (an agent, IDE, or CLI) can spawn it as a subprocess and get 12 memory tools (`memory_store`, `memory_retrieve`, `memory_summarize`, `memory_prune`, etc.), 2 resources, and 1 prompt for free. See [`packages/mcp/README.md`](packages/mcp/README.md) for the full tool/resource/prompt reference and storage-backend options.

This doc collects copy-pasteable config for as many MCP clients as we could verify, plus a generic recipe for anything not listed. If you hit the same setup questions we did, they should be answered here — and if your client isn't listed, the [Universal Pattern](#universal-pattern-any-mcp-client) section covers ~90% of clients since most just wrap the same `command` / `args` / `env` shape.

- **Protocol spec / general reference:** [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Package:** [`@memstack/mcp` on npm](https://www.npmjs.com/package/@memstack/mcp)
- **Source:** [`packages/mcp/src`](packages/mcp/src)

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Step 0: Test the server standalone before wiring up a client](#step-0-test-the-server-standalone-before-wiring-up-a-client)
- [Universal pattern (any MCP client)](#universal-pattern-any-mcp-client)
- [Client-specific setup](#client-specific-setup)
  - [Claude Code](#claude-code)
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
  - [Windsurf](#windsurf)
  - [Cline (VS Code extension)](#cline-vs-code-extension)
  - [Continue.dev](#continuedev)
  - [VS Code (native Copilot Chat MCP support)](#vs-code-native-copilot-chat-mcp-support)
  - [Zed](#zed)
  - [OpenCode](#opencode)
  - [Gemini CLI](#gemini-cli)
  - [Goose](#goose)
- [Testing against your local repo build (not the published npm package)](#testing-against-your-local-repo-build-not-the-published-npm-package)
- [Environment variable reference](#environment-variable-reference)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Node.js 18+ (memstack-mcp is a Node process; the client spawns it, you don't run it directly)
- At least one of `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (required — `packages/mcp/src/config.ts` throws at startup without one)
- A storage backend choice. Default is `MEMSTACK_STORAGE=memory` (nothing persists across restarts) — fine for testing, not for real use. See [Environment variable reference](#environment-variable-reference) for Postgres/Redis/SQLite/disk/markdown options.

---

## Step 0: Test the server standalone before wiring up a client

Before debugging a client integration, confirm the server itself works. Use the official [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx -y @modelcontextprotocol/inspector npx -y @memstack/mcp
```

Set env vars first (`export OPENAI_API_KEY=sk-...` or pass them via the Inspector UI). This opens a local web UI where you can:
- Call `tools/list` to confirm all 12 tools appear
- Invoke `memory_store` / `memory_retrieve` directly and see raw JSON responses
- Read the `memory://{actorId}/context` and `memory://{actorId}/stats` resources
- Call `memory_health` to check storage/LLM/embedding connectivity independently

If this works, any client config problem is a config problem, not a server problem — that split saves a lot of debugging time.

---

## Universal pattern (any MCP client)

Nearly every MCP client uses some variant of this JSON shape for a local (stdio) server:

```json
{
  "mcpServers": {
    "memstack": {
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-...",
        "MEMSTACK_ACTOR": "my-agent"
      }
    }
  }
}
```

If your client isn't in the list below: look for its MCP docs, find where it wants `command`/`args`/`env` (sometimes under a different top-level key — `mcpServers`, `mcp`, `context_servers`, `servers`), and drop in the block above. The `command`/`args` pair is always equivalent to running `npx -y @memstack/mcp` in a terminal with those env vars set.

**Running one shared server instead of one-per-client:** every config above spawns `memstack-mcp` as a local subprocess per client (stdio transport) — fine for one agent per machine, but each client gets its own process and, if using disk/markdown storage, its own file lock. For multiple agents/processes sharing one memory server over the network, run `memstack-mcp --http --port 3939` once and point Streamable-HTTP-capable clients at `http://host:3939/mcp` instead of a `command`/`args` pair. See [`packages/mcp/README.md`](packages/mcp/README.md#transport) for details — this is newer than stdio support in the MCP ecosystem, so check your client's docs for Streamable HTTP support before relying on it.

---

## Client-specific setup

### Claude Code

Docs: [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp)

**CLI (fastest):**
```bash
claude mcp add --transport stdio memstack \
  --env MEMSTACK_STORAGE=memory \
  --env OPENAI_API_KEY=sk-... \
  -- npx -y @memstack/mcp
```

**Or project `.mcp.json`** (commit it so the team shares config):
```json
{
  "mcpServers": {
    "memstack": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

**Verify:** `claude mcp list`, or `/mcp` inside a session to see live connection status and the tool list.

---

### Claude Desktop

Docs: [modelcontextprotocol.io/docs/develop/connect-local-servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

Config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "memstack": {
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

**Verify:** fully quit and reopen Claude Desktop, then check Settings → Developer for a connected "memstack" server, or ask it to remember something and check for a tool-call indicator in the chat.

---

### Cursor

Docs: [cursor.com/docs/mcp](https://cursor.com/docs/mcp)

Config file: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in the project root (project-scoped — Cursor merges both).

```json
{
  "mcpServers": {
    "memstack": {
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

**Verify:** Cursor Settings → MCP shows the server with a green/active status dot and lists its tools.

---

### Windsurf

Docs: [docs.windsurf.com/plugins/cascade/mcp](https://docs.windsurf.com/plugins/cascade/mcp)

Config file: `~/.codeium/windsurf/mcp_config.json` (macOS/Linux), `%USERPROFILE%\.codeium\windsurf\mcp_config.json` (Windows).

```json
{
  "mcpServers": {
    "memstack": {
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Windsurf supports `${env:VAR_NAME}` interpolation if you'd rather reference a variable already in your shell than paste a key into the file.

**Verify:** quit and reopen Windsurf after editing (config isn't hot-reloaded), then check the Cascade MCP panel for "memstack" listed as connected.

---

### Cline (VS Code extension)

Docs: [docs.cline.bot/mcp/mcp-overview](https://docs.cline.bot/mcp/mcp-overview)

Open via: Cline panel → MCP Servers icon → Configure tab → "Configure MCP Servers" (edits `cline_mcp_settings.json` under the hood).

```json
{
  "mcpServers": {
    "memstack": {
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

**Verify:** the Cline MCP Servers panel lists "memstack" with a green status and expandable tool list.

---

### Continue.dev

Docs: [docs.continue.dev/customize/deep-dives/mcp](https://docs.continue.dev/customize/deep-dives/mcp)

Continue uses YAML (`config.yaml`), not JSON, and each server gets a `name` field instead of being keyed by name:

```yaml
mcpServers:
  - name: memstack
    command: npx
    args:
      - -y
      - "@memstack/mcp"
    env:
      MEMSTACK_STORAGE: memory
      OPENAI_API_KEY: sk-...
```

**Verify:** open the Continue panel, check the MCP/tools section for "memstack" and its tool list.

---

### VS Code (native Copilot Chat MCP support)

Docs: [code.visualstudio.com/docs/agent-customization/mcp-servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)

Config file: `.vscode/mcp.json` in the workspace, or run **MCP: Open User Configuration** from the command palette for a user-level config. Note the top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "memstack": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

For secrets, VS Code supports an `inputs` array so you're prompted rather than hardcoding a key in a file you might commit — worth using if `.vscode/mcp.json` is checked into the repo.

**Verify:** the editor shows an inline "Start" affordance above the server block in `mcp.json`, and Copilot Chat's tools picker lists the `memory_*` tools once running.

---

### Zed

Docs: [zed.dev/docs/ai/mcp](https://zed.dev/docs/ai/mcp)

Config file: `~/.config/zed/settings.json`, or `.zed/settings.json` at the project root for team-shared config. Zed keys servers under `context_servers`, not `mcpServers`:

```json
{
  "context_servers": {
    "memstack": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

**Verify:** Zed restarts context servers automatically on save — check the Agent panel's server list for "memstack."

---

### OpenCode

Docs: [opencode.ai/docs/mcp-servers](https://opencode.ai/docs/mcp-servers/) · [opencode.ai/docs/config](https://opencode.ai/docs/config/)

Config file: `opencode.json` in the project root, or `~/.config/opencode/opencode.json` globally. Note `command` is a single array (binary + args combined), there's a required `type: "local"`, and env vars go under `environment`, not `env`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "memstack": {
      "type": "local",
      "command": ["npx", "-y", "@memstack/mcp"],
      "enabled": true,
      "environment": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

**Verify:** `opencode mcp list` shows configured servers and status; `opencode mcp debug memstack` if it won't connect.

---

### Gemini CLI

Docs: [geminicli.com/docs/tools/mcp-server](https://geminicli.com/docs/tools/mcp-server/)

Config file: `settings.json` (project-level `.gemini/settings.json` or user-level `~/.gemini/settings.json`).

```json
{
  "mcpServers": {
    "memstack": {
      "command": "npx",
      "args": ["-y", "@memstack/mcp"],
      "env": {
        "MEMSTACK_STORAGE": "memory",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

**Verify:** run `gemini mcp list` (or the CLI's equivalent tool-listing command) to confirm memstack's tools are discovered.

---

### Goose

Docs: [goose-docs.ai](https://goose-docs.ai/) · [github.com/block/goose](https://github.com/block/goose)

Config file: `~/.config/goose/config.yaml`, under `extensions`:

```yaml
extensions:
  memstack:
    name: memstack
    cmd: npx
    args:
      - -y
      - "@memstack/mcp"
    enabled: true
    type: stdio
    timeout: 300
    envs:
      MEMSTACK_STORAGE: memory
      OPENAI_API_KEY: sk-...
```

Goose also supports adding extensions interactively via `goose configure` if you'd rather not hand-edit YAML.

**Verify:** `goose session` and ask it to list available extensions/tools — `memstack` and its `memory_*` tools should appear.

---

## Testing against your local repo build (not the published npm package)

While iterating on `packages/mcp` itself, point any of the configs above at your local build instead of `npx -y @memstack/mcp`:

```bash
cd packages/mcp
pnpm build
```

Then swap `command`/`args` for:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/memstack/packages/mcp/dist/cli.js"]
}
```

(For Continue/Goose's YAML or OpenCode's array form, apply the same swap — `npx`/`["-y", "@memstack/mcp"]` becomes `node`/`["/absolute/path/.../dist/cli.js"]`.)

---

## Environment variable reference

All configuration is env vars — no config file inside memstack itself. Full detail in [`packages/mcp/README.md`](packages/mcp/README.md).

| Variable | Purpose | Default |
|---|---|---|
| `MEMSTACK_STORAGE` | `memory`, `disk`, `markdown`, `postgres`, `sqlite`, `redis` | `memory` |
| `MEMSTACK_DIR` | Directory for `disk`/`markdown` storage | `./memstack-data` / `./memories` |
| `DATABASE_URL` | Postgres connection string (required if `postgres`) | — |
| `SQLITE_PATH` | SQLite file path | `./memstack.db` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `OPENAI_API_KEY` | OpenAI LLM + embeddings | — |
| `ANTHROPIC_API_KEY` | Anthropic LLM (preferred over OpenAI if both set) | — |
| `MEMSTACK_OPENAI_BASE_URL` | OpenAI-compatible endpoint override (DeepSeek, etc.) — disables embeddings | `https://api.openai.com/v1` |
| `MEMSTACK_LLM_MODEL` | Model override | `gpt-4o-mini` |
| `MEMSTACK_EMBED_ON_STORE` | Auto-embed on store | `true` |
| `MEMSTACK_ACTOR` | Default actor ID (isolates memory per agent) | `default` |

At least one of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` is required — the server throws on startup without one (`packages/mcp/src/config.ts:14-22`).

---

## Troubleshooting

- **Server won't connect / client shows it as failed:** run it manually in a terminal first — `MEMSTACK_STORAGE=memory OPENAI_API_KEY=sk-... npx -y @memstack/mcp` — and read the stderr output directly instead of through the client's UI.
- **Connects but tool calls error:** call `memory_health` (via Inspector or your client) — it reports storage/LLM/embedding connectivity separately, which narrows down "bad API key" vs. "bad DB connection string" fast.
- **Memories don't persist across restarts:** you're on `MEMSTACK_STORAGE=memory` (the default). Switch to `disk`, `markdown`, `postgres`, `redis`, or `sqlite`.
- **Memories seem to bleed across agents/sessions:** set `MEMSTACK_ACTOR` per agent, or pass `actorId` explicitly in tool calls — everything defaults to the `"default"` actor otherwise.
- **`SQLite requires better-sqlite3` / `Redis requires ioredis`:** these are optional peer deps, install them yourself (`npm install better-sqlite3` or `npm install ioredis`) alongside `@memstack/mcp`.
