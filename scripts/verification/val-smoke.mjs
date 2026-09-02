import { InMemoryStorageAdapter } from "../../dist/index.js";

const storage = new InMemoryStorageAdapter();
await storage.initialize();

const stored = await storage.store({
  actorId: "val-adoption",
  content: "MemStack evidence survives a real store and retrieval journey.",
  memoryType: "observation",
  importance: 0.9,
  tags: ["val", "release"],
});
const retrieved = await storage.get(stored.id);
const count = await storage.count({ actorId: "val-adoption" });
await storage.close();

console.log(JSON.stringify({
  status: retrieved?.content === stored.content && count === 1 ? "ok" : "failed",
  id: stored.id,
  content: retrieved?.content,
  count,
}));
