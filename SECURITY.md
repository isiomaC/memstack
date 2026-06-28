# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.6.x   | Yes       |
| < 0.6   | No        |

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
