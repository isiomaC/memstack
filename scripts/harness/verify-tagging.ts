// Live check: store-time tagging with a real OpenAI-compatible provider
// bridges vocabulary for recall. Not run in CI; needs network and a key.
//   DEEPSEEK_API_KEY=... pnpm exec tsx scripts/harness/verify-tagging.ts
import { HarnessMemory, InMemoryStorageAdapter, OpenAILLMAdapter } from "../../src/index.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY");

const llm = new OpenAILLMAdapter({
  apiKey,
  baseURL: "https://api.deepseek.com",
  defaultModel: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
});
const harness = new HarnessMemory({
  storage: new InMemoryStorageAdapter(),
  llm,
  onError: (error) => console.error("tagging error:", error.message),
});
const source = { harness: "verify", project: "demo" };

const cases = [
  { content: "This project uses Hono", question: "What framework does this project use?" },
  { content: "We store data in Postgres 16", question: "Which database do we use?" },
  { content: "Run pnpm verify before opening a pull request", question: "How do I check my changes before a PR?" },
];

let failed = 0;
for (const { content } of cases) {
  const memory = await harness.remember({ namespace: "project:demo", content, source });
  console.log(`stored: ${JSON.stringify(content)} tags=${JSON.stringify(memory.tags)}`);
}
for (const { content, question } of cases) {
  const { hits, fallback } = await harness.recall({ namespaces: ["project:demo"], query: question, limit: 1 });
  const ok = !fallback && hits[0]?.memory.content === content;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${JSON.stringify(question)} -> ${JSON.stringify(hits[0]?.memory.content)}${fallback ? " (fallback)" : ""}`);
}
process.exit(failed ? 1 : 0);
