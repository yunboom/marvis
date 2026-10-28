// DISPATCH_REASON names the admission reason codes clients branch on (read
// with dispatchReasonCode). Values mirror server/internal/dispatch/reason.go;
// an autopilot paused for a missing runtime carries the same code in
// pause_reason.
export const DISPATCH_REASON = {
  invocationNotAllowed: "invocation_not_allowed",
  agentRuntimeRequired: "agent_runtime_required",
} as const;
