import { config } from "./config.js";
import { createApp } from "./http/createApp.js";
import { HeuristicFallbackInterpreter } from "./llm/HeuristicFallbackInterpreter.js";
import { OpenAICompatibleTaskInterpreter } from "./llm/OpenAICompatibleTaskInterpreter.js";
import type { TaskInterpreter } from "./llm/TaskInterpreter.js";
import { PostgresTaskRepository } from "./repositories/PostgresTaskRepository.js";
import { TaskService } from "./services/TaskService.js";

function createInterpreter(): TaskInterpreter {
  if (config.llm.mode === "heuristic") {
    return new HeuristicFallbackInterpreter();
  }

  if (!config.llm.apiKey) {
    throw new Error("LLM_API_KEY is required when LLM_MODE is not set to heuristic.");
  }

  return new OpenAICompatibleTaskInterpreter({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    maxTokens: config.llm.maxTokens,
    openRouterSiteName: config.llm.openRouterSiteName,
    openRouterSiteUrl: config.llm.openRouterSiteUrl
  });
}

async function bootstrap() {
  const repository = new PostgresTaskRepository(config.databaseUrl);
  await repository.ensureSchema();

  const taskService = new TaskService(repository, createInterpreter());
  const app = createApp(taskService);
  const server = app.listen(config.port, () => {
    console.log(`Task tracker listening on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    server.close();
    await repository.close();
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
