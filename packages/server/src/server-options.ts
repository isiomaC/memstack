import { isIPv4 } from "node:net";

export interface ServerOptions {
  hostname: string;
  port: number;
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || (isIPv4(hostname) && hostname.startsWith("127."));
}

export function getServerOptions(env: NodeJS.ProcessEnv): ServerOptions {
  const hostname = env.HOST || "127.0.0.1";
  const port = Number.parseInt(env.PORT || "3000", 10);
  if (!isLoopbackHost(hostname) && !env.MEMSTACK_API_KEY && env.MEMSTACK_ALLOW_INSECURE !== "true") {
    throw new Error(
      `Refusing to bind MemStack to ${hostname} without MEMSTACK_API_KEY. Set MEMSTACK_ALLOW_INSECURE=true to accept the risk explicitly.`,
    );
  }

  return { hostname, port };
}
