import { createHash } from "node:crypto";

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeMessageText(value: string): string {
  return collapseWhitespace(value).toLowerCase().replace(/[.!?]+$/g, "");
}

export function normalizeTitle(value: string): string {
  return collapseWhitespace(value).toLowerCase().replace(/[.!?]+$/g, "");
}

export function normalizeDetail(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

export function createIdempotencyKey(chatId: string, message: string): string {
  const normalized = `${chatId}:${normalizeMessageText(message)}`;
  return createHash("sha256").update(normalized).digest("hex");
}
