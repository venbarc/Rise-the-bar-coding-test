import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleTaskInterpreter } from "../llm/OpenAICompatibleTaskInterpreter.js";
import type { Task } from "../types.js";

class FakeClient {
  private readonly responses: any[];
  public callCount = 0;

  constructor(responses: any[]) {
    this.responses = [...responses];
  }

  chat = {
    completions: {
      create: async (_request: any) => {
        this.callCount += 1;
        const next = this.responses.shift();

        if (!next) {
          throw new Error("No fake response configured.");
        }

        return next;
      }
    }
  };
}

function buildToolResponse(argumentsText: string) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: "function",
              function: {
                name: "submit_task_plan",
                arguments: argumentsText
              }
            }
          ]
        }
      }
    ]
  };
}

function buildTask(id: string, title: string): Task {
  return {
    id,
    chatId: "default",
    title,
    normalizedTitle: title.toLowerCase(),
    status: "open",
    createdAt: "2026-03-18T00:00:00.000Z",
    completedAt: null,
    details: []
  };
}

test("retries once when tool arguments are malformed", async () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const client = new FakeClient([
    buildToolResponse('{"outcome":"plan","operations":[{"type":"complete_task","taskId":"oops"}]}'),
    buildToolResponse(
      JSON.stringify({
        outcome: "plan",
        operations: [{ type: "complete_task", taskId }]
      })
    )
  ]);

  const interpreter = new OpenAICompatibleTaskInterpreter({
    apiKey: "test-key",
    baseUrl: "https://example.com",
    model: "test-model",
    maxTokens: 512,
    client: client as any
  });

  const result = await interpreter.interpret({
    chatId: "default",
    message: "Mark the laundry task as done",
    tasks: [buildTask(taskId, "Do laundry")],
    recentConversation: []
  });

  assert.deepEqual(result, {
    kind: "plan",
    operations: [{ type: "complete_task", taskId }]
  });
  assert.equal(client.callCount, 2);
});

test("surfaces the friendly fallback after a second invalid tool response", async () => {
  const client = new FakeClient([
    buildToolResponse('{"outcome":"plan","operations":[{"type":"complete_task","taskId":"oops"}]}'),
    buildToolResponse('{"outcome":"plan","operations":[{"type":"complete_task","taskId":"still-bad"}]}')
  ]);

  const interpreter = new OpenAICompatibleTaskInterpreter({
    apiKey: "test-key",
    baseUrl: "https://example.com",
    model: "test-model",
    maxTokens: 512,
    client: client as any
  });

  await assert.rejects(
    () =>
      interpreter.interpret({
        chatId: "default",
        message: "Mark the laundry task as done",
        tasks: [buildTask("11111111-1111-4111-8111-111111111111", "Do laundry")],
        recentConversation: []
      }),
    /I couldn't interpret that request reliably/
  );
  assert.equal(client.callCount, 2);
});
