import dotenv from "dotenv";

dotenv.config();

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a number.`);
  }

  return parsed;
}

export const config = {
  port: readNumber("PORT", 3000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  llm: {
    mode: process.env.LLM_MODE ?? (process.env.LLM_API_KEY ? "openai-compatible" : "heuristic"),
    baseUrl: process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "openai/gpt-4.1-mini",
    maxTokens: readNumber("LLM_MAX_TOKENS", 512),
    openRouterSiteUrl: process.env.OPENROUTER_SITE_URL ?? "",
    openRouterSiteName: process.env.OPENROUTER_SITE_NAME ?? ""
  }
};
