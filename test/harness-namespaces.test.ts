import { describe, it, expect } from "vitest";
import {
  GLOBAL_NAMESPACE,
  defaultRecallNamespaces,
  projectNamespace,
  sessionNamespace,
} from "../src/harness/namespaces.js";

describe("harness namespaces", () => {
  it("formats reserved actorId values", () => {
    expect(GLOBAL_NAMESPACE).toBe("global");
    expect(projectNamespace("abc")).toBe("project:abc");
    expect(sessionNamespace("abc", "s1")).toBe("session:abc:s1");
  });

  it("recalls the project, then global, by default", () => {
    expect(defaultRecallNamespaces("abc")).toEqual(["project:abc", "global"]);
  });

  it("rejects empty IDs", () => {
    expect(() => projectNamespace("")).toThrow();
    expect(() => sessionNamespace("abc", "")).toThrow();
  });
});
