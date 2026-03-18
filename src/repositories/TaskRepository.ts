import type {
  AddDetailResult,
  ChatRole,
  CompleteTaskResult,
  ConversationMessage,
  CreateTaskResult,
  ProcessedMessage,
  Task
} from "../types.js";

export interface TaskRepositoryTransaction {
  listTasks(chatId: string): Promise<Task[]>;
  getTask(chatId: string, taskId: string): Promise<Task | null>;
  upsertTask(chatId: string, title: string): Promise<CreateTaskResult>;
  addDetail(taskId: string, text: string): Promise<AddDetailResult>;
  completeTask(chatId: string, taskId: string): Promise<CompleteTaskResult | null>;
  getRecentConversation(chatId: string, limit: number): Promise<ConversationMessage[]>;
  storeConversationMessage(chatId: string, role: ChatRole, content: string): Promise<void>;
  getProcessedMessage(chatId: string, idempotencyKey: string): Promise<ProcessedMessage | null>;
  storeProcessedMessage(
    chatId: string,
    idempotencyKey: string,
    originalText: string,
    normalizedText: string,
    assistantResponse: string
  ): Promise<void>;
  reset(chatId?: string): Promise<void>;
}

export interface TaskRepository extends TaskRepositoryTransaction {
  ensureSchema(): Promise<void>;
  withTransaction<T>(work: (tx: TaskRepositoryTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
