import OpenAI from "openai";
import { z } from "zod";
import type { InterpretationContext, InterpretationResult, TaskInterpreter, TaskOperation } from "./TaskInterpreter.js";

const toolArgsSchema = z.object({
  outcome: z.enum(["plan", "clarify", "noop"]),
  clarifyingQuestion: z.string().trim().optional(),
  response: z.string().trim().optional(),
  operations: z
    .array(
      z.union([
        z.object({
          type: z.literal("create_task"),
          title: z.string().trim().min(1),
          details: z.array(z.string().trim().min(1)).optional()
        }),
        z.object({
          type: z.literal("complete_task"),
          taskId: z.string().uuid()
        }),
        z.object({
          type: z.literal("append_detail"),
          taskId: z.string().uuid(),
          detail: z.string().trim().min(1)
        })
      ])
    )
    .default([])
});

const plannerTool = {
  type: "function" as const,
  function: {
    name: "submit_task_plan",
    description: "Return the structured task-tracker interpretation for the latest user message.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        outcome: {
          type: "string",
          enum: ["plan", "clarify", "noop"]
        },
        clarifyingQuestion: {
          type: "string"
        },
        response: {
          type: "string"
        },
        operations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: {
                type: "string",
                enum: ["create_task", "complete_task", "append_detail"]
              },
              title: {
                type: "string"
              },
              details: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              taskId: {
                type: "string"
              },
              detail: {
                type: "string"
              }
            },
            required: ["type"]
          }
        }
      },
      required: ["outcome", "operations"]
    }
  }
};

function buildSystemPrompt(): string {
  return [
    "You convert chat messages into structured actions for a small task tracker.",
    "Allowed operations:",
    "- create_task: create a new task title, optionally with initial detail notes.",
    "- complete_task: mark an existing task as completed.",
    "- append_detail: add free-text detail to an existing task.",
    "Rules:",
    "- Use only task IDs that are present in the provided context.",
    "- If multiple tasks could match and you are not confident, return outcome=clarify with a short question.",
    "- If the message is not asking to create, complete, or annotate a task, return outcome=noop.",
    "- The task list is small, so infer based on titles, indexes, wording, and recent conversation when reasonable.",
    "- Do not invent tasks or IDs that are not grounded in the input/context.",
    "- If the user names multiple new tasks in one message, emit multiple create_task operations.",
    "- If the user wants to add a note/update to an existing task, use append_detail rather than create_task.",
    "- Prefer concise, action-oriented titles when creating tasks."
  ].join("\n");
}

function buildUserPrompt(context: InterpretationContext): string {
  const tasks = context.tasks.map((task, index) => ({
    displayIndex: index + 1,
    id: task.id,
    title: task.title,
    status: task.status,
    details: task.details.map((detail) => detail.text)
  }));

  const conversation = context.recentConversation.map((message) => ({
    role: message.role,
    content: message.content
  }));

  return JSON.stringify(
    {
      chatId: context.chatId,
      currentTasks: tasks,
      recentConversation: conversation,
      latestUserMessage: context.message
    },
    null,
    2
  );
}

function coercePlan(args: z.infer<typeof toolArgsSchema>): InterpretationResult {
  if (args.outcome === "clarify") {
    return {
      kind: "clarify",
      question: args.clarifyingQuestion || "Which task did you mean?"
    };
  }

  if (args.outcome === "noop") {
    return {
      kind: "noop",
      response: args.response || "I didn't find a task action in that message."
    };
  }

  return {
    kind: "plan",
    operations: args.operations as TaskOperation[]
  };
}

function parseToolArguments(rawArguments: string): z.infer<typeof toolArgsSchema> {
  try {
    return toolArgsSchema.parse(JSON.parse(rawArguments));
  } catch {
    throw new Error("I couldn't interpret that request reliably. Try splitting it into two shorter task messages.");
  }
}

export class OpenAICompatibleTaskInterpreter implements TaskInterpreter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    maxTokens: number;
    openRouterSiteUrl?: string;
    openRouterSiteName?: string;
  }) {
    const defaultHeaders: Record<string, string> = {};

    if (options.openRouterSiteUrl) {
      defaultHeaders["HTTP-Referer"] = options.openRouterSiteUrl;
    }

    if (options.openRouterSiteName) {
      defaultHeaders["X-Title"] = options.openRouterSiteName;
    }

    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined
    });
    this.model = options.model;
    this.maxTokens = options.maxTokens;
  }

  async interpret(context: InterpretationContext): Promise<InterpretationResult> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      max_tokens: this.maxTokens,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt()
        },
        {
          role: "user",
          content: buildUserPrompt(context)
        }
      ],
      tools: [plannerTool],
      tool_choice: {
        type: "function",
        function: {
          name: "submit_task_plan"
        }
      }
    });

    const toolCall = completion.choices[0]?.message.tool_calls?.find(
      (call) => call.type === "function" && call.function.name === "submit_task_plan"
    );

    if (!toolCall || toolCall.type !== "function") {
      throw new Error("LLM response did not include submit_task_plan.");
    }

    const parsed = parseToolArguments(toolCall.function.arguments);
    return coercePlan(parsed);
  }
}

