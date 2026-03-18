import assert from "node:assert/strict";
import test from "node:test";
import type { InterpretationContext, InterpretationResult, TaskInterpreter } from "../llm/TaskInterpreter.js";
import { InMemoryTaskRepository } from "../repositories/InMemoryTaskRepository.js";
import { TaskService } from "../services/TaskService.js";

class TestInterpreter implements TaskInterpreter {
  async interpret(context: InterpretationContext): Promise<InterpretationResult> {
    const tasks = context.tasks;

    switch (context.message) {
      case "Create release tasks":
        return {
          kind: "plan",
          operations: [
            { type: "create_task", title: "Prepare changelog" },
            { type: "create_task", title: "Publish release notes" }
          ]
        };
      case "Complete the changelog task": {
        const task = tasks.find((item) => item.title === "Prepare changelog");

        if (!task) {
          return { kind: "clarify", question: "Which task did you mean?" };
        }

        return {
          kind: "plan",
          operations: [{ type: "complete_task", taskId: task.id }]
        };
      }
      case "Complete that one":
        return {
          kind: "clarify",
          question: "Which task should I mark as completed?"
        };
      case "Add detail to release notes: include migration warning": {
        const task = tasks.find((item) => item.title === "Publish release notes");

        if (!task) {
          return { kind: "clarify", question: "Which task did you mean?" };
        }

        return {
          kind: "plan",
          operations: [
            {
              type: "append_detail",
              taskId: task.id,
              detail: "include migration warning"
            }
          ]
        };
      }
      default:
        return {
          kind: "noop",
          response: "No task action."
        };
    }
  }
}

test("creates multiple tasks from one message", async () => {
  const service = new TaskService(new InMemoryTaskRepository(), new TestInterpreter());

  const result = await service.processUserMessage("Create release tasks");
  const tasks = await service.listTasks();

  assert.match(result.assistantResponse, /Created 2 tasks/);
  assert.equal(tasks.length, 2);
});

test("does not duplicate tasks when the same message is processed twice", async () => {
  const service = new TaskService(new InMemoryTaskRepository(), new TestInterpreter());

  await service.processUserMessage("Create release tasks");
  const replay = await service.processUserMessage("Create release tasks");
  const tasks = await service.listTasks();

  assert.equal(tasks.length, 2);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.assistantResponse, "I already processed that message. No duplicate changes were applied.");
});

test("completes a task from a later message", async () => {
  const service = new TaskService(new InMemoryTaskRepository(), new TestInterpreter());

  await service.processUserMessage("Create release tasks");
  const result = await service.processUserMessage("Complete the changelog task");
  const tasks = await service.listTasks();
  const task = tasks.find((item) => item.title === "Prepare changelog");

  assert.match(result.assistantResponse, /Completed 1 task/);
  assert.equal(task?.status, "completed");
});

test("asks a clarifying question when completion intent is ambiguous", async () => {
  const service = new TaskService(new InMemoryTaskRepository(), new TestInterpreter());

  await service.processUserMessage("Create release tasks");
  const result = await service.processUserMessage("Complete that one");
  const tasks = await service.listTasks();

  assert.equal(result.assistantResponse, "Which task should I mark as completed?");
  assert.equal(tasks.filter((task) => task.status === "completed").length, 0);
});

test("attaches a detail and deduplicates the same detail on replay", async () => {
  const service = new TaskService(new InMemoryTaskRepository(), new TestInterpreter());

  await service.processUserMessage("Create release tasks");
  await service.processUserMessage("Add detail to release notes: include migration warning");
  await service.processUserMessage("Add detail to release notes: include migration warning");

  const tasks = await service.listTasks();
  const task = tasks.find((item) => item.title === "Publish release notes");

  assert.equal(task?.details.length, 1);
  assert.equal(task?.details[0]?.text, "include migration warning");
});
