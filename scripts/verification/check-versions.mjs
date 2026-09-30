import { readFile } from "node:fs/promises";

const manifests = [
  "package.json",
  "packages/cli/package.json",
  "packages/mcp/package.json",
  "packages/server/package.json",
];

const packages = await Promise.all(manifests.map(async (path) => {
  const manifest = JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), "utf8"));
  return { name: manifest.name, version: manifest.version };
}));

const expectedVersion = packages[0].version;
const mismatches = packages.filter(({ version }) => version !== expectedVersion);
if (mismatches.length > 0) {
  throw new Error(`Package version mismatch: ${packages.map(({ name, version }) => `${name}@${version}`).join(", ")}`);
}

// MCP Registry metadata must name the same version as the published packages.
const server = JSON.parse(await readFile(new URL("../../server.json", import.meta.url), "utf8"));
const registryVersions = [
  { name: "server.json", version: server.version },
  ...server.packages.map((entry) => ({ name: `server.json ${entry.identifier}`, version: entry.version })),
];
const registryMismatches = registryVersions.filter(({ version }) => version !== expectedVersion);
if (registryMismatches.length > 0) {
  throw new Error(
    `MCP Registry metadata does not match package version ${expectedVersion}: ${registryMismatches.map(({ name, version }) => `${name}@${version}`).join(", ")}`,
  );
}

const tag = process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag.slice(1) !== expectedVersion) {
  throw new Error(`Release tag ${tag} does not match package version ${expectedVersion}`);
}

console.log(`All publishable packages use version ${expectedVersion}`);
