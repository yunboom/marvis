import { ApiError } from "@marvis/core/api";

/** The machine-readable code of a knowledge base API error ("" when none). */
export function kbErrorCode(error: unknown): string {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return "";
  const code = (error.body as Record<string, unknown>).code;
  return typeof code === "string" ? code : "";
}
