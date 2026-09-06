import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillDirFlag = process.argv.indexOf("--skill-dir");
const skillDir = skillDirFlag === -1
  ? resolve(root, "packages/skills/memstack-cli")
  : resolve(process.argv[skillDirFlag + 1] ?? "");
const skillPath = resolve(skillDir, "SKILL.md");
const referencePath = resolve(skillDir, "REFERENCE.md");
const commands = new Set([
  "store", "retrieve", "context", "summarize", "prune", "purge",
  "merge", "stats", "delete", "health", "export", "import",
]);

const skill = await readFile(skillPath, "utf8");
const reference = await readFile(referencePath, "utf8");
const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

if (!frontmatter) {
  throw new Error("SKILL.md must begin with YAML frontmatter");
}

const metadata = parse(frontmatter[1]);
if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
  throw new Error("SKILL.md frontmatter must be a YAML mapping");
}

for (const field of ["name", "description"]) {
  if (typeof metadata[field] !== "string" || metadata[field].trim() === "") {
    throw new Error(`SKILL.md frontmatter requires a non-empty ${field}`);
  }
}

if (!/\[[^\]]+\]\(REFERENCE\.md(?:#[^)]+)?\)/.test(skill)) {
  throw new Error("SKILL.md must link to REFERENCE.md");
}

for (const match of skill.matchAll(/\[[^\]]+\]\(([^)#]+\.md(?:#[^)]+)?)\)/g)) {
  await access(resolve(dirname(skillPath), match[1].split("#")[0]));
}

for (const source of [skill, reference]) {
  for (const match of source.matchAll(/\bmemstack\s+([a-z-]+)/g)) {
    if (!commands.has(match[1])) {
      throw new Error(`Unknown MemStack CLI command in skill documentation: ${match[1]}`);
    }
  }
}

console.log(`Validated ${metadata.name} skill documentation`);
