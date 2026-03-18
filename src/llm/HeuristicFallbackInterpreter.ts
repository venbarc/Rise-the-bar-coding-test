import { normalizeMessageText } from "../utils/normalize.js";
import type { Task } from "../types.js";
import type { InterpretationContext, InterpretationResult, TaskInterpreter } from "./TaskInterpreter.js";

function findTaskByIndex(tasks: Task[], text: string): Task | null {
  const match = text.match(/\b(?:task\s*)?(\d+)\b/);

  if (!match) {
    return null;
  }

  const index = Number(match[1]) - 1;
  return tasks[index] ?? null;
}

function findTaskByTitle(tasks: Task[], normalizedMessage: string): Task | null {
  const matches = tasks.filter((task) => normalizedMessage.includes(task.normalizedTitle));

  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

function splitCreateCandidates(raw: string): string[] {
  const cleaned = raw
    .replace(/^(add|create|track|todo|to do|tasks?)\s*[:\-]?\s*/i, "")
    .trim();

  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(/\band\b|,|\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function resolveSingleTask(tasks: Task[], normalizedMessage: string): Task | null {
  return findTaskByIndex(tasks, normalizedMessage) ?? findTaskByTitle(tasks, normalizedMessage);
}

export class HeuristicFallbackInterpreter implements TaskInterpreter {
  async interpret(context: InterpretationContext): Promise<InterpretationResult> {
    const normalizedMessage = normalizeMessageText(context.message);

    if (/\b(done|complete|completed|finish|finished|mark .*done)\b/.test(normalizedMessage)) {
      const task = resolveSingleTask(context.tasks, normalizedMessage);

      if (!task) {
        return {
          kind: "clarify",
          question: "Which task should I mark as completed?"
        };
      }

      return {
        kind: "plan",
        operations: [
          {
            type: "complete_task",
            taskId: task.id
          }
        ]
      };
    }

    if (/\b(note|detail|update|append|for task)\b/.test(normalizedMessage)) {
      const task = resolveSingleTask(context.tasks, normalizedMessage);

      if (!task) {
        return {
          kind: "clarify",
          question: "Which task should I attach that detail to?"
        };
      }

      const detail = context.message
        .replace(/^(add|append)?\s*(a\s*)?(note|detail|update)\s*(to|for)\s*/i, "")
        .replace(task.title, "")
        .replace(/^[:\-]\s*/, "")
        .trim();

      if (!detail) {
        return {
          kind: "clarify",
          question: "What detail should I attach to that task?"
        };
      }

      return {
        kind: "plan",
        operations: [
          {
            type: "append_detail",
            taskId: task.id,
            detail
          }
        ]
      };
    }

    if (/\b(add|create|track|todo|to do|tasks?)\b/.test(normalizedMessage)) {
      const titles = splitCreateCandidates(context.message);

      if (titles.length === 0) {
        return {
          kind: "noop",
          response: "I couldn't find a task to create in that message."
        };
      }

      return {
        kind: "plan",
        operations: titles.map((title) => ({
          type: "create_task" as const,
          title
        }))
      };
    }

    return {
      kind: "noop",
      response: "I didn't find a task action in that message."
    };
  }
}
