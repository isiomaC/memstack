import type { Memory, MemoryType } from "../../types.js";
import type { StorageProvider, MemoryStoreInput, MemoryRetrieveQuery, MemoryCountFilter } from "../../interfaces.js";
import { storageError, notFound } from "../../errors.js";

type Neo4jDriver = {
  session(opts?: { database?: string }): Neo4jSession;
  close(): Promise<void>;
};

type Neo4jSession = {
  run(query: string, params?: Record<string, unknown>): Promise<{ records: { get(key: string): unknown; toObject(): Record<string, unknown> }[] }>;
  close(): Promise<void>;
};

interface Neo4jMemoryNode {
  id: string;
  actorId: string;
  memoryType: string;
  content: string;
  importance: number;
  emotionalValence: number;
  tags: string[];
  sourceId: string | null;
  metadata: string;
  expiresAt: string | null;
  createdAt: string;
  embedding: number[] | null;
}

export interface Neo4jStorageConfig {
  driver: Neo4jDriver;
  database?: string;
}

export class Neo4jStorageAdapter implements StorageProvider {
  private driver: Neo4jDriver;
  private database: string;

  constructor(config: Neo4jStorageConfig) {
    this.driver = config.driver;
    this.database = config.database ?? "neo4j";
  }

  async initialize(): Promise<void> {
    const session = this.driver.session({ database: this.database });
    try {
      await session.run(
        "CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE"
      );
      await session.run(
        `CREATE VECTOR INDEX memory_embedding IF NOT EXISTS FOR (m:Memory) ON m.embedding
         OPTIONS { indexConfig: { \`vector.dimensions\`: 1536, \`vector.similarity_function\`: "cosine" } }`
      );
    } finally {
      await session.close();
    }
  }

  generateId(): string {
    return `mem_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  }

  async store(input: MemoryStoreInput): Promise<Memory> {
    const now = new Date().toISOString();
    const id = input.id ?? this.generateId();

    const props: Record<string, unknown> = {
      actorId: input.actorId,
      memoryType: input.memoryType ?? "interaction",
      content: input.content,
      importance: input.importance ?? 0.5,
      emotionalValence: input.emotionalValence ?? 0,
      tags: input.tags ?? [],
      sourceId: input.sourceId ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      expiresAt: input.expiresAt?.toISOString() ?? null,
      createdAt: now,
      embedding: input.embedding ?? null,
    };

    const { createdAt: _, ...updateProps } = props;

    const session = this.driver.session({ database: this.database });
    try {
      await session.run(
        "MERGE (m:Memory {id: $id}) ON CREATE SET m += $props ON MATCH SET m += $updateProps",
        { id, props, updateProps }
      );
    } finally {
      await session.close();
    }

    return {
      id,
      actorId: input.actorId,
      memoryType: (input.memoryType ?? "interaction") as MemoryType,
      content: input.content,
      importance: input.importance ?? 0.5,
      emotionalValence: input.emotionalValence ?? 0,
      tags: input.tags ?? [],
      embedding: input.embedding,
      sourceId: input.sourceId,
      metadata: input.metadata ?? {},
      expiresAt: input.expiresAt,
      createdAt: new Date(now),
    };
  }

  async storeBatch(inputs: MemoryStoreInput[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const input of inputs) {
      results.push(await this.store(input));
    }
    return results;
  }

  async get(id: string): Promise<Memory | null> {
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        "MATCH (m:Memory {id: $id}) WHERE m.expiresAt IS NULL OR m.expiresAt > datetime() RETURN m",
        { id }
      );
      if (result.records.length === 0) return null;
      const raw = result.records[0].get("m") as Record<string, unknown>;
      const node = (raw.properties ?? raw) as Neo4jMemoryNode;
      return this._nodeToMemory(node);
    } finally {
      await session.close();
    }
  }

  async delete(id: string): Promise<void> {
    const session = this.driver.session({ database: this.database });
    try {
      const check = await session.run("MATCH (m:Memory {id: $id}) RETURN m.id as id", { id });
      if (check.records.length === 0) throw notFound("Memory", id);
      await session.run("MATCH (m:Memory {id: $id}) DETACH DELETE m", { id });
    } finally {
      await session.close();
    }
  }

  async deleteMany(ids: string[]): Promise<number> {
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        "UNWIND $ids AS mid MATCH (m:Memory {id: mid}) DETACH DELETE m RETURN count(m) as deleted",
        { ids }
      );
      const record = result.records[0];
      if (!record) return 0;
      return record.get("deleted") as number;
    } finally {
      await session.close();
    }
  }

  async retrieve(query: MemoryRetrieveQuery, embedding?: number[]): Promise<Memory[]> {
    const session = this.driver.session({ database: this.database });
    try {
      const limit = Math.floor(query.limit ?? 10);
      const strategy = query.strategy ?? "hybrid";

      if (strategy === "semantic" && embedding) {
        return this._semanticRetrieve(session, embedding, query, limit);
      }

      const strLimit = String(limit);
      let cypher: string;
      const params: Record<string, unknown> = {};

      const hasActor = query.actorId !== undefined;

      switch (strategy) {
        case "recent":
          if (hasActor) {
             cypher = "MATCH (m:Memory) WHERE m.actorId = $actorId RETURN m ORDER BY m.createdAt DESC LIMIT " + strLimit;
            params.actorId = query.actorId;
          } else {
            cypher = "MATCH (m:Memory) RETURN m ORDER BY m.createdAt DESC LIMIT " + strLimit;
          }
          break;
        case "important":
          if (hasActor) {
            cypher = "MATCH (m:Memory) WHERE m.actorId = $actorId RETURN m ORDER BY m.importance DESC LIMIT " + strLimit;
            params.actorId = query.actorId;
          } else {
            cypher = "MATCH (m:Memory) RETURN m ORDER BY m.importance DESC LIMIT " + strLimit;
          }
          break;
        case "hybrid":
        default:
          if (embedding) {
            return this._semanticRetrieve(session, embedding, query, limit);
          }
          if (hasActor) {
            cypher = "MATCH (m:Memory) WHERE m.actorId = $actorId RETURN m ORDER BY m.importance DESC, m.createdAt DESC LIMIT " + strLimit;
            params.actorId = query.actorId;
          } else {
            cypher = "MATCH (m:Memory) RETURN m ORDER BY m.importance DESC, m.createdAt DESC LIMIT " + strLimit;
          }
          break;
      }

      const result = await session.run(cypher, params);
      const memories = result.records.map((r) => {
        const raw = r.get("m") as Record<string, unknown>;
        const node = (raw.properties ?? raw) as Neo4jMemoryNode;
        return this._nodeToMemory(node);
      });

      return this._postFilter(memories, query);
    } finally {
      await session.close();
    }
  }

  async count(filter?: MemoryCountFilter): Promise<number> {
    const session = this.driver.session({ database: this.database });
    try {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter?.actorId) {
        conditions.push("m.actorId = $actorId");
        params.actorId = filter.actorId;
      }
      if (filter?.memoryType) {
        conditions.push("m.memoryType = $memoryType");
        params.memoryType = filter.memoryType;
      }
      if (filter?.minImportance !== undefined) {
        conditions.push("m.importance >= $minImportance");
        params.minImportance = filter.minImportance;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await session.run(
        `MATCH (m:Memory) ${where} RETURN count(m) as count`,
        params
      );
      const rawCount = result.records[0].get("count");
      return typeof rawCount === "number" ? rawCount : Number(rawCount);
    } finally {
      await session.close();
    }
  }

  async graphQuery(cypher: string, params?: Record<string, unknown>): Promise<Memory[]> {
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(cypher, params);
      return result.records.map((r) => {
        const obj = r.toObject();
        const mKey = Object.keys(obj).find((k) => obj[k] && typeof obj[k] === "object" && "properties" in (obj[k] as object));
        if (mKey) {
          const raw = obj[mKey] as Record<string, unknown>;
          const node = (raw.properties ?? raw) as Neo4jMemoryNode;
          return this._nodeToMemory(node);
        }
        return this._nodeToMemory(obj as unknown as Neo4jMemoryNode);
      });
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private async _semanticRetrieve(
    session: Neo4jSession,
    embedding: number[],
    query: MemoryRetrieveQuery,
    limit: number
  ): Promise<Memory[]> {
    const hasActor = query.actorId !== undefined;
    const strLimit = String(limit);
    const cypher = hasActor
      ? `CALL db.index.vector.queryNodes('memory_embedding', ${strLimit}, $embedding) YIELD node, score
         MATCH (node) WHERE node.actorId = $actorId
         RETURN node ORDER BY score LIMIT ${strLimit}`
       : `CALL db.index.vector.queryNodes('memory_embedding', ${strLimit}, $embedding) YIELD node, score
         RETURN node ORDER BY score LIMIT ${strLimit}`;
    const params: Record<string, unknown> = { embedding };
    if (hasActor) params.actorId = query.actorId;

    const result = await session.run(cypher, params);
    const memories = result.records.map((r) => {
      const raw = r.get("node") as Record<string, unknown>;
      const node = (raw.properties ?? raw) as Neo4jMemoryNode;
      return this._nodeToMemory(node);
    });

    return this._postFilter(memories, query);
  }

  private _postFilter(memories: Memory[], query: MemoryRetrieveQuery): Memory[] {
    const now = new Date();
    let results = memories.filter((m) => !m.expiresAt || m.expiresAt > now);

    if (query.memoryTypes && query.memoryTypes.length > 0) {
      results = results.filter((m) => query.memoryTypes!.includes(m.memoryType));
    }
    if (query.tags && query.tags.length > 0) {
      results = results.filter((m) => m.tags?.some((t) => query.tags!.includes(t)));
    }
    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter((m) => m.content.toLowerCase().includes(q));
    }

    return results;
  }

  private _nodeToMemory(node: Neo4jMemoryNode): Memory {
    return {
      id: node.id,
      actorId: node.actorId,
      memoryType: (node.memoryType ?? "interaction") as MemoryType,
      content: node.content,
      importance: node.importance ?? 0.5,
      emotionalValence: node.emotionalValence ?? 0,
      tags: Array.isArray(node.tags) ? node.tags : [],
      embedding: node.embedding ?? undefined,
      sourceId: node.sourceId ?? undefined,
      metadata: typeof node.metadata === "string" ? JSON.parse(node.metadata) : (node.metadata ?? {}),
      expiresAt: node.expiresAt ? new Date(node.expiresAt) : undefined,
      createdAt: new Date(node.createdAt),
    };
  }
}
