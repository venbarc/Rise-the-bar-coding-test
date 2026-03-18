import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { TaskService } from "../services/TaskService.js";

function parseChatId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), 100);
}

export function createApp(taskService: TaskService) {
  const app = express();
  const publicDir = path.resolve(process.cwd(), "public");

  app.use(express.json());
  app.use(express.static(publicDir));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/chat/history", async (request, response, next) => {
    try {
      const messages = await taskService.getConversation(
        parseChatId(request.query.chatId),
        parseLimit(request.query.limit, 30)
      );
      response.json({ messages });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tasks", async (request, response, next) => {
    try {
      const tasks = await taskService.listTasks(parseChatId(request.query.chatId));
      response.json({ tasks });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tasks/:taskId", async (request, response, next) => {
    try {
      const task = await taskService.getTask(request.params.taskId, parseChatId(request.query.chatId));

      if (!task) {
        response.status(404).json({ error: "Task not found." });
        return;
      }

      response.json({ task });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/chat", async (request, response, next) => {
    try {
      const message = typeof request.body?.message === "string" ? request.body.message : "";
      const chatId = parseChatId(request.body?.chatId);
      const result = await taskService.processUserMessage(message, chatId);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/complete", async (request, response, next) => {
    try {
      const chatId = parseChatId(request.body?.chatId);
      const assistantResponse = await taskService.completeTaskDirect(request.params.taskId, chatId);
      response.json({ assistantResponse, idempotentReplay: false });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/reset", async (request, response, next) => {
    try {
      await taskService.reset(parseChatId(request.body?.chatId));
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Message cannot be empty." ? 400 : message === "Task not found." ? 404 : 500;
    response.status(status).json({ error: message });
  });

  return app;
}
