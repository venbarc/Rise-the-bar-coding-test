export type ChatRole = "user" | "assistant";
export type TaskStatus = "open" | "completed";

export interface TaskDetail {
  id: string;
  taskId: string;
  text: string;
  normalizedText: string;
  createdAt: string;
}

export interface Task {
  id: string;
  chatId: string;
  title: string;
  normalizedTitle: string;
  status: TaskStatus;
  createdAt: string;
  completedAt: string | null;
  details: TaskDetail[];
}

export interface ConversationMessage {
  id: string;
  chatId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface ProcessedMessage {
  id: string;
  chatId: string;
  idempotencyKey: string;
  originalText: string;
  normalizedText: string;
  assistantResponse: string;
  createdAt: string;
}

export interface CreateTaskResult {
  task: Task;
  created: boolean;
}

export interface AddDetailResult {
  detail: TaskDetail;
  created: boolean;
}

export interface CompleteTaskResult {
  task: Task;
  changed: boolean;
}

export interface ProcessMessageResult {
  assistantResponse: string;
  idempotentReplay: boolean;
}
