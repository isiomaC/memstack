import { describe, it, expect } from "vitest";
import { scanSecrets, redactSecrets, filterSecrets } from "../src/security/secrets.js";

// Built from parts so this file does not itself look like a leaked credential.
const fake = {
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  github: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  slack: "xoxb-" + "123456789012-abcdefghijkl",
  stripe: "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  anthropic: "sk-ant-" + "api03-AbCdEfGhIjKlMnOpQrStUv",
  openai: "sk-proj-" + "AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  google: "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
  npm: "npm_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  jwt: "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dBjftJeZ4CVPmB92K27uhbUJU1p1r",
};

const kinds = (text: string) => scanSecrets(text).map((m) => m.kind);

describe("scanSecrets", () => {
  it.each([
    ["aws-access-key", `key is ${fake.aws} for the bucket`],
    ["github-token", `use ${fake.github}`],
    ["slack-token", `bot token ${fake.slack}`],
    ["stripe-key", `${fake.stripe}`],
    ["anthropic-key", `${fake.anthropic}`],
    ["openai-key", `${fake.openai}`],
    ["google-api-key", `${fake.google}`],
    ["npm-token", `${fake.npm}`],
    ["jwt", `${fake.jwt}`],
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"],
    ["bearer-token", "send Authorization: Bearer abcDEF1234567890abcdEFGH"],
    ["connection-string", "DATABASE_URL=postgres://app:s3cr3tPassw0rd@db.internal:5432/app"],
    ["credential-assignment", 'DB_PASSWORD="hunter2-Prod!9x"'],
    ["credential-assignment", "api_key: 9f8e7d6c5b4a3f2e1d0c"],
  ])("finds %s", (kind, text) => {
    expect(kinds(text)).toContain(kind);
  });

  it("covers an unterminated private key block", () => {
    const text = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B";
    const [m] = scanSecrets(text);
    expect(m.kind).toBe("private-key");
    expect(m.end).toBe(text.length);
  });

  it.each([
    "This project uses Hono for the API",
    "The password policy requires 12 characters",
    "password: required",
    "token: refreshed",
    "We rotate the API key every 90 days",
    "max_tokens: 4096 per request",
    "tokenizer = BM25Retriever",
    "Set OPENAI_API_KEY in your environment",
    "api_key = process.env.OPENAI_API_KEY",
    "password=<your-password-here>",
    "secret: ${SECRET_VALUE}",
    "postgres://user:password@localhost:5432/app",
    "risk-management-process-for-all-teams-in-the-organisation-here",
    "See https://example.com/docs/page?id=12345 for details",
    "commit 3b2bcb1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c",
  ])("leaves %j alone", (text) => {
    expect(scanSecrets(text)).toEqual([]);
  });

  it("never returns the secret text", () => {
    const text = `token ${fake.github}`;
    expect(JSON.stringify(scanSecrets(text))).not.toContain(fake.github);
  });

  it("merges overlapping matches", () => {
    const text = `ANTHROPIC_API_KEY=${fake.anthropic}`;
    const matches = scanSecrets(text);
    expect(matches).toHaveLength(1);
    expect(redactSecrets(text, matches)).not.toContain(fake.anthropic);
  });
});

describe("filterSecrets", () => {
  const text = `Deploys use ${fake.aws} and ${fake.github}.`;

  it("redacts every secret and keeps the surrounding text", () => {
    const out = filterSecrets(text, "redact");
    expect(out.text).toBe("Deploys use [REDACTED:aws-access-key] and [REDACTED:github-token].");
    expect(out.kinds).toEqual(["aws-access-key", "github-token"]);
  });

  it("reports kinds without changing the text under reject", () => {
    const out = filterSecrets(text, "reject");
    expect(out.text).toBe(text);
    expect(out.kinds).toEqual(["aws-access-key", "github-token"]);
  });

  it("does nothing when off", () => {
    expect(filterSecrets(text, "off")).toEqual({ text, kinds: [] });
  });
});
