/**
 * Deterministic secret detection. Runs before a memory reaches an LLM
 * provider or storage. It has no dependencies and makes no network calls.
 *
 * It looks for credentials with a recognisable shape (private keys, cloud and
 * source-host tokens, JWTs, passwords in connection strings) and for
 * `name = value` assignments where the name says "secret" and the value looks
 * random. It is a safety net, not a guarantee: a secret in a format it does
 * not know will pass.
 */

export type SecretKind =
  | "private-key"
  | "aws-access-key"
  | "github-token"
  | "slack-token"
  | "stripe-key"
  | "anthropic-key"
  | "openai-key"
  | "google-api-key"
  | "npm-token"
  | "jwt"
  | "bearer-token"
  | "connection-string"
  | "credential-assignment";

export interface SecretMatch {
  kind: SecretKind;
  /** Offset of the first character of the secret in the scanned text. */
  start: number;
  /** Offset just past the last character of the secret. */
  end: number;
}

interface Rule {
  kind: SecretKind;
  pattern: RegExp;
  /** Which capture group holds the secret. Default 0, the whole match. */
  group?: number;
  /** Extra check on the captured secret; return false to ignore the match. */
  accept?: (secret: string) => boolean;
}

const PLACEHOLDER = /^(?:<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Z_]+%|\$[A-Z_]+|x{3,}|\*{3,}|\.{3,}|your[-_ ]|changeme|change-me|example|placeholder|dummy|redacted|todo|null|undefined|none|process\.env|env\[|os\.environ|getenv)/i;

/** Shannon entropy in bits per character. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const RULES: Rule[] = [
  {
    kind: "private-key",
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: "bearer-token",
    pattern: /\b(?:authorization\s*[:=]\s*)?bearer\s+([A-Za-z0-9._~+/=-]{20,})/gi,
    group: 1,
    accept: (s) => !PLACEHOLDER.test(s) && /[0-9]/.test(s),
  },
  {
    kind: "connection-string",
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]+:([^\s@/]{3,})@[^\s/]+/gi,
    group: 1,
    // Docs write `user:password@host`; the literal word is a placeholder.
    accept: (s) => !PLACEHOLDER.test(s) && !/^(?:password|passwd|pass|pwd|secret)$/i.test(s),
  },
  {
    kind: "credential-assignment",
    // name = "value", name: value, NAME=value. The name must say it is secret.
    pattern:
      /\b[\w.-]*(?:password|passwd|pwd|secret|secret[_-]?key|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|token)["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
    group: 1,
    accept: (s) => {
      if (PLACEHOLDER.test(s)) return false;
      const hasLetter = /[A-Za-z]/.test(s);
      const hasOther = /[0-9]|[^A-Za-z0-9]/.test(s);
      // Plain words ("required", "rotated") are prose, not secrets.
      return hasLetter && hasOther && entropy(s) >= 3;
    },
  },
];

/** Every secret found in `text`, in order, with overlaps merged. Never returns the secret itself. */
export function scanSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      const secret = m[rule.group ?? 0];
      if (!secret) continue;
      if (rule.accept && !rule.accept(secret)) continue;
      const start = (m.index ?? 0) + (rule.group ? m[0].indexOf(secret) : 0);
      found.push({ kind: rule.kind, start, end: start + secret.length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretMatch[] = [];
  for (const match of found) {
    const last = merged[merged.length - 1];
    if (last && match.start < last.end) {
      if (match.end > last.end) last.end = match.end;
      continue;
    }
    merged.push({ ...match });
  }
  return merged;
}

/** `text` with each match replaced by `[REDACTED:<kind>]`. */
export function redactSecrets(text: string, matches: SecretMatch[]): string {
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + `[REDACTED:${m.kind}]`;
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

/** What to do with a memory that contains a secret. */
export type SecretPolicy = "reject" | "redact" | "off";

export interface SecretFilterResult {
  /** The text to store: unchanged, or redacted under the `redact` policy. */
  text: string;
  /** The kinds found, without duplicates. Empty when the text was clean. */
  kinds: SecretKind[];
}

/** Scan `text` and apply the redaction half of a policy. `reject` is the caller's job. */
export function filterSecrets(text: string, policy: SecretPolicy): SecretFilterResult {
  if (policy === "off") return { text, kinds: [] };
  const matches = scanSecrets(text);
  const kinds = [...new Set(matches.map((m) => m.kind))];
  if (matches.length === 0 || policy === "reject") return { text, kinds };
  return { text: redactSecrets(text, matches), kinds };
}
