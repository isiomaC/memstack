import type { Quest, QuestStatus, QuestObjective } from "../types.js";
import type { QuestCreateInput, QuestListOptions } from "../interfaces.js";
import { notFound, validationError } from "../errors.js";

export class QuestManager {
  private quests: Map<string, Quest> = new Map();

  generateId(): string {
    return `quest_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
  }

  async create(input: QuestCreateInput): Promise<Quest> {
    if (!input.title.trim()) throw validationError("Quest title is required");
    if (!input.giverId) throw validationError("Quest giverId is required");

    const now = new Date();
    const quest: Quest = {
      id: this.generateId(),
      title: input.title,
      description: input.description,
      giverId: input.giverId,
      status: "offered",
      objectives: input.objectives.map((obj, i) => ({
        ...obj,
        index: i,
        isComplete: false,
        currentCount: 0,
      })),
      rewards: input.rewards,
      timeLimit: input.timeLimit,
      prerequisites: input.prerequisites,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.quests.set(quest.id, quest);
    return quest;
  }

  async get(id: string): Promise<Quest | null> {
    return this.quests.get(id) ?? null;
  }

  async list(options?: QuestListOptions): Promise<Quest[]> {
    let results = Array.from(this.quests.values());

    if (options?.playerId) {
      results = results.filter((q) => q.takerId === options.playerId);
    }
    if (options?.giverId) {
      results = results.filter((q) => q.giverId === options.giverId);
    }
    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      results = results.filter((q) => statuses.includes(q.status));
    }

    return results;
  }

  async accept(id: string, playerId: string): Promise<Quest> {
    const quest = this.quests.get(id);
    if (!quest) throw notFound("Quest", id);
    if (quest.status !== "offered") {
      throw validationError(`Quest "${quest.title}" is not available (status: ${quest.status})`);
    }
    if (quest.prerequisites) {
      for (const prereqId of quest.prerequisites) {
        const prereq = this.quests.get(prereqId);
        if (!prereq || prereq.status !== "completed") {
          throw validationError(`Prerequisite quest not completed: ${prereqId}`);
        }
      }
    }

    quest.takerId = playerId;
    quest.status = "accepted";
    quest.updatedAt = new Date();
    return quest;
  }

  async updateObjective(
    questId: string,
    objIndex: number,
    complete: boolean
  ): Promise<Quest> {
    const quest = this.quests.get(questId);
    if (!quest) throw notFound("Quest", questId);
    if (quest.status !== "in_progress" && quest.status !== "accepted") {
      throw validationError(`Cannot update objectives for ${quest.status} quest`);
    }

    const obj = quest.objectives.find((o) => o.index === objIndex);
    if (!obj) {
      throw notFound("Objective", `quest=${questId}, index=${objIndex}`);
    }

    obj.isComplete = complete;
    if (complete && obj.currentCount !== undefined && obj.targetCount !== undefined) {
      obj.currentCount = obj.targetCount;
    }
    quest.updatedAt = new Date();

    if (quest.status === "accepted") {
      quest.status = "in_progress";
    }

    // Auto-complete if all non-optional objectives are done
    const requiredObjectives = quest.objectives.filter((o) => !o.isOptional);
    if (requiredObjectives.every((o) => o.isComplete)) {
      quest.status = "completed";
      quest.updatedAt = new Date();
    }

    return quest;
  }

  async complete(id: string): Promise<Quest> {
    const quest = this.quests.get(id);
    if (!quest) throw notFound("Quest", id);
    if (quest.status !== "in_progress" && quest.status !== "accepted") {
      throw validationError(`Cannot complete quest with status: ${quest.status}`);
    }

    quest.status = "completed";
    quest.objectives.forEach((obj) => {
      if (!obj.isOptional) obj.isComplete = true;
    });
    quest.updatedAt = new Date();
    return quest;
  }

  async fail(id: string): Promise<Quest> {
    const quest = this.quests.get(id);
    if (!quest) throw notFound("Quest", id);
    if (quest.status === "completed" || quest.status === "failed") {
      throw validationError(`Cannot fail quest with status: ${quest.status}`);
    }

    quest.status = "failed";
    quest.updatedAt = new Date();
    return quest;
  }

  export(): Quest[] {
    return Array.from(this.quests.values());
  }

  import(quests: Quest[]): void {
    for (const quest of quests) {
      this.quests.set(quest.id, quest);
    }
  }
}
