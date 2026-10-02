# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.8.x   | Yes       |
| < 0.8   | No        |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email **chuck.contactme@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact

You will receive a response within 72 hours. If the issue is confirmed, a patch will be released as soon as possible and you will be credited in the changelog unless you prefer otherwise.

## Scope

MemStack is a client-side library. The main security considerations are:

- **Data handling** — memories may contain sensitive conversation data; use a storage backend with appropriate access controls in production
- **API key injection** — LLM and embedding adapter credentials are caller-supplied; never log or serialize the config object
- **`@memstack/server`** — enable `MEMSTACK_API_KEY` in any non-local deployment; the server has no auth by default

### Harness memory (Claude Code and Codex)

- **LLM key.** `memstack init` stores the key in `~/.memstack/config.json`, created with mode `0600` in a `0700` directory, so it never appears in agent configs. Any process running as you can still read it; `memstack doctor` warns if the permissions are broader. Commands never print the key.
- **Agent configuration.** `memstack connect` changes only MemStack's own entries: the `memstack` MCP server (through each agent's `mcp` commands), a `SessionStart` hook, and for Codex a marked block in `~/.codex/AGENTS.md`. Each file is backed up under `~/.memstack/backups/` first, and `memstack disconnect` restores it exactly. Codex runs the hook only after you approve it with `/hooks`; MemStack does not bypass that.
- **Memory contents.** Agents are instructed never to store secrets, but memories are not yet scanned for them: whatever an agent stores is saved, and the session-start hook prints the project's most important memories into new sessions. Review stored memories with `memstack memories` and delete with `memstack memories --delete <id>`.
- **Project isolation.** The harness tools take no actor ID: each server is scoped to the project it started in, and `memory_get`/`memory_delete` refuse IDs from other projects. Bulk and destructive tools are not exposed to agents.
- **Shared stores.** Everyone who can reach a shared store (for example a Postgres database used from several machines) can read its memories. Protect it like any database holding conversation data.
