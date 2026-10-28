import type { KeyboardEvent } from "react";
import { isImeComposing } from "@marvis/core/utils";

/**
 * Whether a keydown in a comment box should send it.
 *
 * Plain Enter (with or without Cmd/Ctrl) submits and Shift+Enter breaks the
 * line. The Enter that confirms an IME candidate only confirms it. Callers
 * call `preventDefault()` on a match so the Enter does not also insert a line
 * break, and keep their own empty / in-flight guard in the submit handler.
 */
export function isSubmitEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !isImeComposing(event);
}
