import { randomUUID } from "node:crypto";
import { normalizeDetail, normalizeMessageText, normalizeTitle } from "../utils/normalize.js";
import type {
  AddDetailResult,
  ChatRole,
  CompleteTaskResult,
  ConversationMessage,
  CreateTaskResult,
  ProcessedMessage,
  Task,
  TaskDetail
} from "../types.js";
import type { TaskRepository, TaskRepositoryTransaction } from "./TaskRepository.js";

function cloneDetail(detail: TaskDetail): TaskDetail {
  return { ...detail };
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    details: task.details.map(cloneDetail)
  };
}

function cloneConversationMessage(message: ConversationMessage): ConversationMessage {
  return { ...message };
}

function cloneProcessedMessage(message: ProcessedMessage): ProcessedMessage {
  return { ...message };
}

export class InMemoryTaskRepository implements TaskRepository, TaskRepositoryTransaction {
  private tasks = new Map<string, Task>();
  private taskIdsByChatAndTitle = new Map<string, string>();
  private processedMessages = new Map<string, ProcessedMessage>();
  private conversationMessages: ConversationMessage[] = [];

  async ensureSchema(): Promise<void> {
    return;
  }

  async withTransaction<T>(work: (tx: TaskRepositoryTransaction) => Promise<T>): Promise<T> {
    return work(this);
  }

  async close(): Promise<void> {
    return;
  }

  async listTasks(chatId: string): Promise<Task[]> {
    return Array.from(this.tasks.values())
      .filter((task) => task.chatId === chatId)
      .sort((left, right) => {
        if (left.status !== right.status) {
          return left.status === "open" ? -1 : 1;
        }

        return right.createdAt.localeCompare(left.createdAt);
      })
      .map(cloneTask);
  }

  async getTask(chatId: string, taskId: string): Promise<Task | null> {
    const task = this.tasks.get(taskId);

    if (!task || task.chatId !== chatId) {
      return null;
    }

    return cloneTask(task);
  }

  async upsertTask(chatId: string, title: string): Promise<CreateTaskResult> {
    const normalized = normalizeTitle(title);
    const key = `${chatId}:${normalized}`;
    const existingId = this.taskIdsByChatAndTitle.get(key);

    if (existingId) {
      const existingTask = this.tasks.get(existingId);

      if (!existingTask) {
        throw new Error(`Corrupt in-memory task index for ${key}.`);
      }

      return {
        task: cloneTask(existingTask),
        created: false
      };
    }

    const task: Task = {
      id: randomUUID(),
      chatId,
      title: title.trim(),
      normalizedTitle: normalized,
      status: "open",
      createdAt: new Date().toISOString(),
      completedAt: null,
      details: []
    };

    this.tasks.set(task.id, task);
    this.taskIdsByChatAndTitle.set(key, task.id);

    return {
      task: cloneTask(task),
      created: true
    };
  }

  async addDetail(taskId: string, text: string): Promise<AddDetailResult> {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const normalized = normalizeDetail(text);
    const existing = task.details.find((detail) => detail.normalizedText === normalized);

    if (existing) {
      return {
        detail: cloneDetail(existing),
        created: false
      };
    }

    const detail: TaskDetail = {
      id: randomUUID(),
      taskId,
      text: text.trim(),
      normalizedText: normalized,
      createdAt: new Date().toISOString()
    };

    task.details = [...task.details, detail];

    return {
      detail: cloneDetail(detail),
      created: true
    };
  }

  async completeTask(chatId: string, taskId: string): Promise<CompleteTaskResult | null> {
    const task = this.tasks.get(taskId);

    if (!task || task.chatId !== chatId) {
      return null;
    }

    const changed = task.status !== "completed";

    if (changed) {
      task.status = "completed";
      task.completedAt = new Date().toISOString();
    }

    return {
      task: cloneTask(task),
      changed
    };
  }

  async getRecentConversation(chatId: string, limit: number): Promise<ConversationMessage[]> {
    return this.conversationMessages
      .filter((message) => message.chatId === chatId)
      .slice(-limit)
      .map(cloneConversationMessage);
  }

  async storeConversationMessage(chatId: string, role: ChatRole, content: string): Promise<void> {
    this.conversationMessages.push({
      id: randomUUID(),
      chatId,
      role,
      content,
      createdAt: new Date().toISOString()
    });
  }

  async getProcessedMessage(chatId: string, idempotencyKey: string): Promise<ProcessedMessage | null> {
    const processed = this.processedMessages.get(`${chatId}:${idempotencyKey}`);
    return processed ? cloneProcessedMessage(processed) : null;
  }

  async storeProcessedMessage(
    chatId: string,
    idempotencyKey: string,
    originalText: string,
    normalizedText: string,
    assistantResponse: string
  ): Promise<void> {
    this.processedMessages.set(`${chatId}:${idempotencyKey}`, {
      id: randomUUID(),
      chatId,
      idempotencyKey,
      originalText,
      normalizedText: normalizeMessageText(normalizedText),
      assistantResponse,
      createdAt: new Date().toISOString()
    });
  }

  async reset(chatId?: string): Promise<void> {
    if (!chatId) {
      this.tasks.clear();
      this.taskIdsByChatAndTitle.clear();
      this.processedMessages.clear();
      this.conversationMessages = [];
      return;
    }

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.chatId === chatId) {
        this.tasks.delete(taskId);
        this.taskIdsByChatAndTitle.delete(`${chatId}:${task.normalizedTitle}`);
      }
    }

    for (const key of this.processedMessages.keys()) {
      if (key.startsWith(`${chatId}:`)) {
        this.processedMessages.delete(key);
      }
    }

    this.conversationMessages = this.conversationMessages.filter((message) => message.chatId !== chatId);
  }
}
