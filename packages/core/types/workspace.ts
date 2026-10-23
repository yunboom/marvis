export type MemberRole = "owner" | "admin" | "member";

export interface WorkspaceRepo {
  url: string;
  description?: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  context: string | null;
  settings: Record<string, unknown>;
  repos: WorkspaceRepo[];
  issue_prefix: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One MCP server in the workspace's library.
 *
 * This is the WHOLE read shape: the stored configuration is write-only, so
 * urls, commands, headers, and env never leave the server for any role. UI
 * that needs to change an entry sends a replacement rather than editing what
 * it read back.
 *
 * `enabled` is only present on an AGENT's assignment list, where it is the
 * per-agent toggle; the workspace library listing has no binding to report.
 */
export interface WorkspaceMcpServer {
  id: string;
  workspace_id: string;
  name: string;
  transport: string;
  enabled?: boolean;
  /**
   * Live agents the entry is assigned to. Only the workspace library listing
   * carries it, and servers older than this field omit it.
   */
  agent_count?: number;
  created_at: string;
  updated_at: string;
}

export interface Member {
  id: string;
  workspace_id: string;
  user_id: string;
  role: MemberRole;
  created_at: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  onboarded_at: string | null;
  /**
   * JSONB payload from the server. Typed as `unknown` here so this module
   * stays independent of the questionnaire shape — the onboarding views
   * cast into `Partial<QuestionnaireAnswers>` when reading. Server always
   * returns an object (defaults to `{}`), never null.
   */
  onboarding_questionnaire: Record<string, unknown>;
  /** Preferred UI language. null means "follow client/system". */
  language: string | null;
  /**
   * Free-form self-description (role, stack, preferences). Injected into
   * the agent brief so coding agents have cheap, durable context about
   * who is requesting the work. Server always returns a string —
   * NOT NULL DEFAULT '' at the column level, empty when unset.
   */
  profile_description: string;
  /** Pinned IANA tz; null means "use browser-detected tz at render time". */
  timezone: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemberWithUser {
  id: string;
  workspace_id: string;
  user_id: string;
  role: MemberRole;
  created_at: string;
  name: string;
  email: string;
  avatar_url: string | null;
}

export interface Invitation {
  id: string;
  workspace_id: string;
  inviter_id: string;
  invitee_email: string;
  invitee_user_id: string | null;
  role: MemberRole;
  status: "pending" | "accepted" | "declined" | "expired";
  created_at: string;
  updated_at: string;
  expires_at: string;
  inviter_name?: string;
  inviter_email?: string;
  workspace_name?: string;
}

export interface ShareLink {
  id: string;
  workspace_id: string;
  code: string;
  created_by: string;
  role: MemberRole;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  is_active: boolean;
  created_at: string;
  creator_name?: string;
  creator_email?: string;
}

export interface ShareLinkInfo {
  workspace_name: string;
  workspace_slug: string;
  creator_name?: string;
  role: MemberRole;
}

// 飞书邀请。字段与服务端 lark_invite.go 的 JSON 一致（snake_case）。

/** LarkInviteStatus 是邀请的状态，由服务端按字段推导，不落库。 */
export type LarkInviteStatus = "active" | "completed" | "expired" | "revoked";

/** LarkInviteTarget 是邀请卡片的接收方：一个群或一个人。 */
export interface LarkInviteTarget {
  type: "chat" | "user";
  id: string;
  id_type: string;
  name: string;
  avatar_url: string | null;
}

/** LarkInviteActor 是发送邀请的成员，或代发的智能体。 */
export interface LarkInviteActor {
  id: string;
  name: string;
  avatar_url: string | null;
}

/** LarkInviteJoinedUser 是通过邀请卡片加入工作区的人。 */
export interface LarkInviteJoinedUser {
  user_id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  joined_at: string;
}

/** LarkInvite 是列表、详情、撤销接口返回的一条邀请。 */
export interface LarkInvite {
  id: string;
  target: LarkInviteTarget;
  role: MemberRole;
  status: LarkInviteStatus;
  use_count: number;
  max_uses: number | null;
  expires_at: string;
  revoked_at: string | null;
  note: string;
  sent_by: LarkInviteActor;
  sent_by_agent: LarkInviteActor | null;
  created_at: string;
  joined: LarkInviteJoinedUser[];
}

/** LarkInviteSendResult 是单个接收方的发送结果，失败时 id、expires_at、max_uses 为 null。 */
export interface LarkInviteSendResult {
  id: string | null;
  target: LarkInviteTarget;
  role: MemberRole;
  expires_at: string | null;
  max_uses: number | null;
  status: "sent" | "failed";
  error: { code: string; message: string } | null;
}

/** LarkChat 是机器人所在的一个飞书群；member_count 目前服务端恒为 0。 */
export interface LarkChat {
  chat_id: string;
  name: string;
  avatar_url: string | null;
  member_count: number;
}

/** LarkUserLookup 是按邮箱查到的飞书用户。 */
export interface LarkUserLookup {
  open_id: string;
  name: string;
  avatar_url: string | null;
  email: string;
}

/** LarkInviteWelcome 是通过飞书邀请加入后，首次进入工作区时的提示内容。 */
export interface LarkInviteWelcome {
  invite_id: string;
  inviter_name: string;
  role: MemberRole;
}

/**
 * LARK_INVITE_ERROR_CODES 是飞书邀请接口返回的错误码，响应体形如 `{"error", "code"}`，
 * 单个接收方失败时同样的 code 出现在 `LarkInviteSendResult.error.code`。
 * 界面和 CLI 按错误码翻译提示，不直接显示服务端的英文说明。
 */
export const LARK_INVITE_ERROR_CODES = [
  "lark_not_configured",
  "permission_denied",
  "invalid_target",
  "invalid_request",
  "invite_not_found",
  "bot_not_in_chat",
  "user_not_found",
  "user_not_in_app_scope",
  "open_id_cross_app",
  "send_failed",
] as const;

/** LarkInviteErrorCode 是 LARK_INVITE_ERROR_CODES 的联合类型。 */
export type LarkInviteErrorCode = (typeof LARK_INVITE_ERROR_CODES)[number];
