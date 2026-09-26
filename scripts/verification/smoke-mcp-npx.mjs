// Runs each database-backend MCP config documented in docs/MCP_SETUP.md
// exactly as written, through npx, against packed release artifacts and real
// Postgres/Redis services. Only `@memstack/mcp` is swapped for the local
// tarballs, and placeholder URLs/keys are replaced with the test services.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const postgresImage = "pgvector/pgvector@sha256:be400b50812ab2cc908ed78593fda2e51e3b45fe774fa637f1c7b16e68531d95";
const redisImage = "redis/redis-stack-server@sha256:798ab84d9f266936b034ab11c4d04a2b8e4b441884c5aa7d17ac951eefdf742a";
const backends = ["sqlite", "postgres", "redis"];

function documentedConfigs() {
  const doc = readFileSync(join(root, "docs/MCP_SETUP.md"), "utf8");
  const start = doc.indexOf("## Database backends");
  if (start === -1) throw new Error("docs/MCP_SETUP.md has no Database backends section");
  const section = doc.slice(start, doc.indexOf("\n---", start));
  const configs = new Map();
  for (const [, block] of section.matchAll(/```json\n([\s\S]*?)```/g)) {
    const server = JSON.parse(block).mcpServers.memstack;
    configs.set(server.env.MEMSTACK_STORAGE, server);
  }
  for (const backend of backends) {
    const config = configs.get(backend);
    if (!config) throw new Error(`docs/MCP_SETUP.md documents no ${backend} config`);
    if (config.command !== "npx" || !config.args.includes("@memstack/mcp")) {
      throw new Error(`${backend} config must run @memstack/mcp through npx`);
    }
  }
  return configs;
}

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitReady(container, ...command) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker("exec", container, ...command);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  throw new Error(`${container} did not become ready:\n${docker("logs", container)}`);
}

// One MCP session with a single tool call. The server must exit on its own
// once stdin closes, and stdout must carry only JSON-RPC messages.
function mcpCall(args, env, cwd, tool, toolArguments) {
  const requests = [
    { jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "npx-smoke", version: "1.0.0" } }, id: 1 },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "tools/call", params: { name: tool, arguments: toolArguments }, id: 2 },
  ];
  return new Promise((resolveCall, reject) => {
    const child = spawn("npx", args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // Generous: the first run may compile better-sqlite3 from source.
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`npx ${args.join(" ")} did not exit within 600s:\n${stderr}`));
    }, 600_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`npx ${args.join(" ")} exited ${code}:\n${stderr}`));
      const lines = stdout.trim().split("\n");
      let messages;
      try {
        messages = lines.map((line) => JSON.parse(line));
      } catch {
        return reject(new Error(`stdout is not pure JSON-RPC:\n${stdout}`));
      }
      const result = messages.find((message) => message.id === 2)?.result;
      if (!result || result.isError) return reject(new Error(`${tool} failed:\n${stdout}\n${stderr}`));
      resolveCall(result.content[0].text);
    });
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
}

const temporaryDir = mkdtempSync(join(tmpdir(), "memstack-mcp-npx-"));
const suffix = process.pid;
const containers = [];

try {
  const configs = documentedConfigs();

  const packDir = join(temporaryDir, "tarballs");
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: root, stdio: "ignore" });
  execFileSync("pnpm", ["--dir", "packages/mcp", "pack", "--pack-destination", packDir], { cwd: root, stdio: "ignore" });
  const tarball = (prefix) => join(packDir, readdirSync(packDir).find((name) => name.startsWith(prefix)));
  // Unpublished @memstack/core must come from the local pack too, not npm.
  const localPackages = ["-p", tarball("memstack-core-"), "-p", tarball("memstack-mcp-")];

  const postgres = `memstack-mcp-npx-postgres-${suffix}`;
  const redis = `memstack-mcp-npx-redis-${suffix}`;
  containers.push(postgres, redis);
  docker("run", "--detach", "--name", postgres, "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_USER=memstack", "--env", "POSTGRES_PASSWORD=memstack", "--env", "POSTGRES_DB=memstack", postgresImage);
  docker("run", "--detach", "--name", redis, "--publish", "127.0.0.1::6379", redisImage);
  // TCP, not the socket: the image's first-boot init server listens on the socket only.
  await waitReady(postgres, "psql", "-h", "127.0.0.1", "-U", "memstack", "-d", "memstack", "-c", "SELECT 1");
  await waitReady(redis, "redis-cli", "ping");
  const port = (container, containerPort) => docker("port", container, containerPort).split("\n")[0].split(":").pop();

  const services = {
    sqlite: { SQLITE_PATH: join(temporaryDir, "memstack.db") },
    postgres: { DATABASE_URL: `postgresql://memstack:memstack@127.0.0.1:${port(postgres, "5432/tcp")}/memstack` },
    redis: { REDIS_URL: `redis://127.0.0.1:${port(redis, "6379/tcp")}` },
  };

  for (const backend of backends) {
    const config = configs.get(backend);
    const args = config.args.flatMap((arg, index) =>
      arg === "@memstack/mcp" && config.args[index - 1] === "-p" ? localPackages.slice(1) : [arg]);
    const env = {
      ...config.env,
      ...services[backend],
      OPENAI_API_KEY: "npx-smoke",
      MEMSTACK_EMBED_ON_STORE: "false",
      // A fresh cache per run proves the documented drivers install cleanly.
      npm_config_cache: join(temporaryDir, "npm-cache"),
      npm_config_update_notifier: "false",
    };
    const content = `MCP npx smoke ${backend}`;

    await mcpCall(args, env, temporaryDir, "memory_store", { content });
    // A second process must see the memory, so it was persisted, not cached.
    const retrieved = JSON.parse(await mcpCall(args, env, temporaryDir, "memory_retrieve", {}));
    if (!retrieved.some((memory) => memory.content === content)) {
      throw new Error(`${backend}: memory_retrieve did not return the stored memory`);
    }
    console.log(`MCP npx smoke passed: ${backend} (${config.args.join(" ")})`);
  }
} finally {
  for (const container of containers) {
    try { docker("rm", "-f", container); } catch { /* already gone */ }
  }
  rmSync(temporaryDir, { recursive: true, force: true });
}
