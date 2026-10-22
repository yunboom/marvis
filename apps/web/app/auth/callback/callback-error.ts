import { ApiError, clientErrorMessage, errorCode } from "@marvis/core/api";

export type CallbackError =
  | {
      kind:
        | "missing_code"
        | "access_denied"
        | "login_failed"
        | "account_disabled"
        | "signup_prohibited"
        | "email_not_allowed"
        | "google_account_no_email"
        | "oauth_code_invalid"
        | "lark_account_no_email"
        | "lark_tenant_not_allowed";
    }
  | { kind: "raw"; text: string };

export function callbackErrorFrom(err: unknown): CallbackError {
  // An actionable code is meaningful only on a client error. A drifting server
  // must not turn a provider/internal failure into a specific user diagnosis.
  if (!(err instanceof ApiError) || err.status < 400 || err.status >= 500) {
    return { kind: "login_failed" };
  }

  switch (errorCode(err)) {
    case "account_disabled":
      return { kind: "account_disabled" };
    case "signup_prohibited":
      return { kind: "signup_prohibited" };
    case "email_not_allowed":
      return { kind: "email_not_allowed" };
    case "google_account_no_email":
      return { kind: "google_account_no_email" };
    case "oauth_code_invalid":
      return { kind: "oauth_code_invalid" };
    case "lark_account_no_email":
      return { kind: "lark_account_no_email" };
    case "lark_tenant_not_allowed":
      return { kind: "lark_tenant_not_allowed" };
    default:
      break;
  }

  const clientMessage = clientErrorMessage(err);
  return clientMessage
    ? { kind: "raw", text: clientMessage }
    : { kind: "login_failed" };
}
