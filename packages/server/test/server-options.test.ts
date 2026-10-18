import { describe, expect, it } from "vitest";
import { getServerOptions, isLoopbackHost } from "../src/server-options.js";

describe("getServerOptions", () => {
  it("binds to loopback by default", () => {
    expect(getServerOptions({})).toEqual({ hostname: "127.0.0.1", port: 3000 });
  });

  it("requires an API key before binding to a non-loopback host", () => {
    expect(() => getServerOptions({ HOST: "0.0.0.0" })).toThrow(/MEMSTACK_API_KEY/);
    expect(getServerOptions({ HOST: "0.0.0.0", MEMSTACK_API_KEY: "secret" }).hostname).toBe("0.0.0.0");
  });

  it("allows an explicit insecure remote bind", () => {
    expect(getServerOptions({ HOST: "0.0.0.0", MEMSTACK_ALLOW_INSECURE: "true" }).hostname).toBe("0.0.0.0");
  });

  it("does not treat hostnames starting with 127. as loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.example.com")).toBe(false);
    expect(() => getServerOptions({ HOST: "127.example.com" })).toThrow(/MEMSTACK_API_KEY/);
  });
});
