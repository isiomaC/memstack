export interface ServerOptions {
  hostname: string;
  port: number;
}

export function getServerOptions(env: NodeJS.ProcessEnv): ServerOptions {
  const hostname = env.HOST || "127.0.0.1";
  const port = Number.parseInt(env.PORT || "3000", 10);
  const loopback = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");

  if (!loopback && !env.MEMSTACK_API_KEY && env.MEMSTACK_ALLOW_INSECURE !== "true") {
    throw new Error(
      `Refusing to bind MemStack to ${hostname} without MEMSTACK_API_KEY. Set MEMSTACK_ALLOW_INSECURE=true to accept the risk explicitly.`,
    );
  }

  return { hostname, port };
}
