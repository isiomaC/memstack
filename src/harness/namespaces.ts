// Namespace values for harness memory, stored in `actorId` (ADR 0001, D2).
// `global`, `project:`, and `session:` are reserved actorId values.

export const GLOBAL_NAMESPACE = "global";

export function projectNamespace(projectId: string): string {
  if (!projectId) throw new Error("projectId is required");
  return `project:${projectId}`;
}

export function sessionNamespace(projectId: string, sessionId: string): string {
  if (!projectId || !sessionId) throw new Error("projectId and sessionId are required");
  return `session:${projectId}:${sessionId}`;
}

/** Namespaces a harness recalls from by default: the project, then global. */
export function defaultRecallNamespaces(projectId: string): string[] {
  return [projectNamespace(projectId), GLOBAL_NAMESPACE];
}
