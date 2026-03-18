import type { InterpretationContext, InterpretationResult, TaskInterpreter } from "../llm/TaskInterpreter.js";
import { InMemoryTaskRepository } from "../repositories/InMemoryTaskRepository.js";
import { TaskService } from "../services/TaskService.js";

class DemoInterpreter implements TaskInterpreter {
  async interpret(context: InterpretationContext): Promise<InterpretationResult> {
    const tasks = context.tasks;

    if (context.message === "Create follow up items") {
      return {
        kind: "plan",
        operations: [
          { type: "create_task", title: "Email the client" },
          { type: "create_task", title: "Update the roadmap" }
        ]
      };
    }

    if (context.message === "Mark the client email as done") {
      const task = tasks.find((item) => item.title === "Email the client");

      if (!task) {
        return {
          kind: "clarify",
          question: "Which task did you mean?"
        };
      }

      return {
        kind: "plan",
        operations: [{ type: "complete_task", taskId: task.id }]
      };
    }

    if (context.message === "Add detail to the roadmap task: waiting on marketing input") {
      const task = tasks.find((item) => item.title === "Update the roadmap");

      if (!task) {
        return {
          kind: "clarify",
          question: "Which task did you mean?"
        };
      }

      return {
        kind: "plan",
        operations: [
          {
            type: "append_detail",
            taskId: task.id,
            detail: "waiting on marketing input"
          }
        ]
      };
    }

    return {
      kind: "noop",
      response: "No task action."
    };
  }
}

async function run() {
  const repository = new InMemoryTaskRepository();
  const service = new TaskService(repository, new DemoInterpreter());

  const first = await service.processUserMessage("Create follow up items");
  const second = await service.processUserMessage("Create follow up items");

  console.log("First response:", first.assistantResponse);
  console.log("Second response:", second.assistantResponse);
  console.log("Second call replayed:", second.idempotentReplay);

  const tasksAfterCreate = await service.listTasks();
  console.log("Task count after duplicate create:", tasksAfterCreate.length);

  const complete = await service.processUserMessage("Mark the client email as done");
  console.log("Complete response:", complete.assistantResponse);

  const detail = await service.processUserMessage("Add detail to the roadmap task: waiting on marketing input");
  console.log("Detail response:", detail.assistantResponse);

  const tasks = await service.listTasks();
  console.log(
    JSON.stringify(
      tasks.map((task) => ({
        title: task.title,
        status: task.status,
        details: task.details.map((entry) => entry.text)
      })),
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
