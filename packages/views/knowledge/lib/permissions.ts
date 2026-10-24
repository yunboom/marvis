import type { MemberRole } from "@marvis/core/types";

/** Owners and admins merge change requests, delete knowledge bases and run the daily digest. */
export function canAdministerWorkspace(role: MemberRole | null): boolean {
  return role === "owner" || role === "admin";
}
