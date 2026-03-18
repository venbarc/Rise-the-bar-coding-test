import { createIdempotencyKey, normalizeMessageText } from "../utils/normalize.js";
import type { ConversationMessage, ProcessMessageResult, Task } from "../types.js";
import type { TaskRepository, TaskRepositoryTransaction } from "../repositories/TaskRepository.js";
import type {
  AppendDetailOperation,
  CreateTaskOperation,
  InterpretationResult,
  TaskInterpreter,
  TaskOperation
} from "../llm/TaskInterpreter.js";

interface TaskServiceOptions {
  chatId?: string;
  recentConversationLimit?: number;
}

const IDEMPOTENT_REPLAY_RESPONSE = "I already processed that message. No duplicate changes were applied.";

interface AppliedSummary {
  createdTasks: string[];
  existingTasks: string[];
  completedTasks: string[];
  alreadyCompletedTasks: string[];
  attachedDetails: Array<{
    taskTitle: string;
    created: boolean;
  }>;
  unresolvedOperations: number;
}

function assertNonEmptyMessage(message: string): string {
  const trimmed = message.trim();

  if (!trimmed) {
    throw new Error("Message cannot be empty.");
  }

  return trimmed;
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function findTaskByIndex(tasks: Task[], text: string): Task | null {
  const match = text.match(/\b(?:task\s*)?(\d+)\b/);

  if (!match) {
    return null;
  }

  const index = Number(match[1]) - 1;
  return tasks[index] ?? null;
}

function findTaskByTitle(tasks: Task[], normalizedMessage: string): Task | null {
  const openMatches = tasks.filter((task) => task.status === "open" && normalizedMessage.includes(task.normalizedTitle));

  if (openMatches.length === 1) {
    return openMatches[0];
  }

  const allMatches = tasks.filter((task) => normalizedMessage.includes(task.normalizedTitle));

  if (allMatches.length === 1) {
    return allMatches[0];
  }

  return null;
}

function resolveExplicitCompletionTarget(tasks: Task[], normalizedMessage: string): Task | null {
  if (!/\b(done|complete|completed|finish|finished)\b/.test(normalizedMessage) && !/\bmark\b.*\b(done|complete|completed)\b/.test(normalizedMessage)) {
    return null;
  }

  return findTaskByIndex(tasks, normalizedMessage) ?? findTaskByTitle(tasks, normalizedMessage);
}
function summarizeAppliedWork(summary: AppliedSummary): string {
  const lines: string[] = [];

  if (summary.createdTasks.length > 0) {
    lines.push(`Created ${formatCount(summary.createdTasks.length, "task", "tasks")}: ${summary.createdTasks.join(", ")}.`);
  }

  if (summary.existingTasks.length > 0) {
    lines.push(
      `Skipped ${formatCount(summary.existingTasks.length, "duplicate task", "duplicate tasks")}: ${summary.existingTasks.join(", ")}.`
    );
  }

  if (summary.completedTasks.length > 0) {
    lines.push(`Completed ${formatCount(summary.completedTasks.length, "task", "tasks")}: ${summary.completedTasks.join(", ")}.`);
  }

  if (summary.alreadyCompletedTasks.length > 0) {
    lines.push(`Already completed: ${summary.alreadyCompletedTasks.join(", ")}.`);
  }

  if (summary.attachedDetails.length > 0) {
    const createdCount = summary.attachedDetails.filter((detail) => detail.created).length;
    const dedupedCount = summary.attachedDetails.length - createdCount;

    if (createdCount > 0) {
      const titles = summary.attachedDetails
        .filter((detail) => detail.created)
        .map((detail) => detail.taskTitle);
      lines.push(`Added ${formatCount(createdCount, "detail", "details")} to: ${titles.join(", ")}.`);
    }

    if (dedupedCount > 0) {
      const titles = summary.attachedDetails
        .filter((detail) => !detail.created)
        .map((detail) => detail.taskTitle);
      lines.push(`Skipped ${formatCount(dedupedCount, "duplicate detail", "duplicate details")} on: ${titles.join(", ")}.`);
    }
  }

  if (summary.unresolvedOperations > 0 && lines.length === 0) {
    return "I couldn't match that to a task. Which task did you mean?";
  }

  if (summary.unresolvedOperations > 0) {
    lines.push("Some requested changes could not be matched to an existing task.");
  }

  if (lines.length === 0) {
    return "I didn't apply any task changes.";
  }

  return lines.join(" ");
}

export class TaskService {
  private readonly defaultChatId: string;
  private readonly recentConversationLimit: number;

  constructor(
    private readonly repository: TaskRepository,
    private readonly interpreter: TaskInterpreter,
    options: TaskServiceOptions = {}
  ) {
    this.defaultChatId = options.chatId ?? "default";
    this.recentConversationLimit = options.recentConversationLimit ?? 8;
  }

  resolveChatId(chatId?: string): string {
    return chatId?.trim() || this.defaultChatId;
  }

  async getConversation(chatId?: string, limit = 30): Promise<ConversationMessage[]> {
    return this.repository.getRecentConversation(this.resolveChatId(chatId), limit);
  }

  async listTasks(chatId?: string): Promise<Task[]> {
    return this.repository.listTasks(this.resolveChatId(chatId));
  }

  async getTask(taskId: string, chatId?: string): Promise<Task | null> {
    return this.repository.getTask(this.resolveChatId(chatId), taskId);
  }

  async completeTaskDirect(taskId: string, chatId?: string): Promise<string> {
    const resolvedChatId = this.resolveChatId(chatId);
    const result = await this.repository.withTransaction(async (tx) => tx.completeTask(resolvedChatId, taskId));

    if (!result) {
      throw new Error("Task not found.");
    }

    return result.changed
      ? `Completed task: ${result.task.title}.`
      : `Task was already completed: ${result.task.title}.`;
  }

  async reset(chatId?: string): Promise<void> {
    const resolvedChatId = chatId?.trim() || undefined;
    await this.repository.reset(resolvedChatId);
  }

  async processUserMessage(message: string, chatId?: string): Promise<ProcessMessageResult> {
    const trimmedMessage = assertNonEmptyMessage(message);
    const resolvedChatId = this.resolveChatId(chatId);
    const normalizedMessage = normalizeMessageText(trimmedMessage);
    const idempotencyKey = createIdempotencyKey(resolvedChatId, trimmedMessage);

    const existing = await this.repository.getProcessedMessage(resolvedChatId, idempotencyKey);

    if (existing) {
      return this.repository.withTransaction(async (tx) => {
        await tx.storeConversationMessage(resolvedChatId, "user", trimmedMessage);
        await tx.storeConversationMessage(resolvedChatId, "assistant", IDEMPOTENT_REPLAY_RESPONSE);

        return {
          assistantResponse: IDEMPOTENT_REPLAY_RESPONSE,
          idempotentReplay: true
        };
      });
    }

    const [tasks, recentConversation] = await Promise.all([
      this.repository.listTasks(resolvedChatId),
      this.repository.getRecentConversation(resolvedChatId, this.recentConversationLimit)
    ]);

    const interpreted = await this.interpreter.interpret({
      chatId: resolvedChatId,
      message: trimmedMessage,
      tasks,
      recentConversation
    });

    const explicitCompletionTarget = resolveExplicitCompletionTarget(tasks, normalizedMessage);
    const interpretation =
      explicitCompletionTarget && interpreted.kind !== "plan"
        ? {
            kind: "plan" as const,
            operations: [{ type: "complete_task" as const, taskId: explicitCompletionTarget.id }]
          }
        : interpreted;

    return this.repository.withTransaction(async (tx) => {
      const replay = await tx.getProcessedMessage(resolvedChatId, idempotencyKey);

      if (replay) {
        await tx.storeConversationMessage(resolvedChatId, "user", trimmedMessage);
        await tx.storeConversationMessage(resolvedChatId, "assistant", IDEMPOTENT_REPLAY_RESPONSE);

        return {
          assistantResponse: IDEMPOTENT_REPLAY_RESPONSE,
          idempotentReplay: true
        };
      }

      const assistantResponse = await this.applyInterpretation(
        tx,
        interpretation,
        trimmedMessage,
        normalizedMessage,
        idempotencyKey,
        resolvedChatId
      );

      return {
        assistantResponse,
        idempotentReplay: false
      };
    });
  }

  private async applyInterpretation(
    tx: TaskRepositoryTransaction,
    interpretation: InterpretationResult,
    originalMessage: string,
    normalizedMessage: string,
    idempotencyKey: string,
    chatId: string
  ): Promise<string> {
    let assistantResponse = "";

    if (interpretation.kind === "clarify") {
      assistantResponse = interpretation.question;
    } else if (interpretation.kind === "noop") {
      assistantResponse = interpretation.response;
    } else {
      const applied = await this.applyOperations(tx, interpretation.operations, chatId);
      assistantResponse = summarizeAppliedWork(applied);
    }

    await tx.storeConversationMessage(chatId, "user", originalMessage);
    await tx.storeConversationMessage(chatId, "assistant", assistantResponse);
    await tx.storeProcessedMessage(chatId, idempotencyKey, originalMessage, normalizedMessage, assistantResponse);

    return assistantResponse;
  }

  private async applyOperations(
    tx: TaskRepositoryTransaction,
    operations: TaskOperation[],
    chatId: string
  ): Promise<AppliedSummary> {
    const summary: AppliedSummary = {
      createdTasks: [],
      existingTasks: [],
      completedTasks: [],
      alreadyCompletedTasks: [],
      attachedDetails: [],
      unresolvedOperations: 0
    };

    for (const operation of operations) {
      if (operation.type === "create_task") {
        await this.applyCreateOperation(tx, operation, chatId, summary);
        continue;
      }

      if (operation.type === "complete_task") {
        const result = await tx.completeTask(chatId, operation.taskId);

        if (!result) {
          summary.unresolvedOperations += 1;
          continue;
        }

        if (result.changed) {
          summary.completedTasks.push(result.task.title);
        } else {
          summary.alreadyCompletedTasks.push(result.task.title);
        }

        continue;
      }

      await this.applyAppendDetailOperation(tx, operation, chatId, summary);
    }

    return summary;
  }

  private async applyCreateOperation(
    tx: TaskRepositoryTransaction,
    operation: CreateTaskOperation,
    chatId: string,
    summary: AppliedSummary
  ): Promise<void> {
    const result = await tx.upsertTask(chatId, operation.title);

    if (result.created) {
      summary.createdTasks.push(result.task.title);
    } else {
      summary.existingTasks.push(result.task.title);
    }

    for (const detail of operation.details ?? []) {
      const detailResult = await tx.addDetail(result.task.id, detail);
      summary.attachedDetails.push({
        taskTitle: result.task.title,
        created: detailResult.created
      });
    }
  }

  private async applyAppendDetailOperation(
    tx: TaskRepositoryTransaction,
    operation: AppendDetailOperation,
    chatId: string,
    summary: AppliedSummary
  ): Promise<void> {
    const task = await tx.getTask(chatId, operation.taskId);

    if (!task) {
      summary.unresolvedOperations += 1;
      return;
    }

    const detailResult = await tx.addDetail(task.id, operation.detail);
    summary.attachedDetails.push({
      taskTitle: task.title,
      created: detailResult.created
    });
  }
}
