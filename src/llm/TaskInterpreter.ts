import type { ConversationMessage, Task } from "../types.js";

export interface CreateTaskOperation {
  type: "create_task";
  title: string;
  details?: string[];
}

export interface CompleteTaskOperation {
  type: "complete_task";
  taskId: string;
}

export interface AppendDetailOperation {
  type: "append_detail";
  taskId: string;
  detail: string;
}

export type TaskOperation = CreateTaskOperation | CompleteTaskOperation | AppendDetailOperation;

export interface InterpretationContext {
  chatId: string;
  message: string;
  tasks: Task[];
  recentConversation: ConversationMessage[];
}

export type InterpretationResult =
  | {
      kind: "plan";
      operations: TaskOperation[];
    }
  | {
      kind: "clarify";
      question: string;
    }
  | {
      kind: "noop";
      response: string;
    };

export interface TaskInterpreter {
  interpret(context: InterpretationContext): Promise<InterpretationResult>;
}
