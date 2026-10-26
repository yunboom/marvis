/**
 * Centralized URL path builder. All navigation in shared packages (packages/views)
 * MUST go through this module — no hardcoded string paths.
 *
 * Two kinds of paths:
 *  - workspace-scoped: paths.workspace(slug).xxx() — carry workspace in URL
 *  - global: paths.login(), paths.newWorkspace(), paths.invite(id) — pre-workspace routes
 *
 * Why pure functions + builder pattern:
 *  - Changing a route shape (e.g. adding workspace slug prefix) becomes a single-file edit
 *  - IDs are always URL-encoded here so callers can't forget
 *  - Zero runtime deps means this module is safe in Node (tests) and browsers
 */

const encode = (id: string) => encodeURIComponent(id);

/**
 * `?focus=` token that scrolls the agent's General settings to its
 * conversation-starters editor and flashes it. Lives here because it is URL
 * vocabulary: `agentConversationStarters()` writes it and the page reads it,
 * and a shared constant is what stops the two from drifting apart.
 */
export const AGENT_FOCUS_CONVERSATION_STARTERS = "conversation_starters";

/**
 * What an entry point brings into a new knowledge base job: the starter, the
 * annotations, the page (checked, or the parent of a new page), raw source
 * uris, and the member's request already written out.
 */
export interface KbNewJobContext {
  starter?: string;
  annotations?: readonly string[];
  page?: string;
  sources?: readonly string[];
  message?: string;
}

/** Tabs of knowledge base management; raw files is the default route. */
export const KB_MANAGE_TABS = ["raw", "export", "delete"] as const;
export type KbManageTab = (typeof KB_MANAGE_TABS)[number];

/** Query keys of the new job route; the page reads them back. */
export const KB_NEW_JOB_PARAMS = {
  starter: "starter",
  annotations: "annotations",
  page: "page",
  sources: "sources",
  message: "message",
} as const;

function kbNewJobQuery(context: KbNewJobContext): string {
  const search = new URLSearchParams();
  if (context.starter) search.set(KB_NEW_JOB_PARAMS.starter, context.starter);
  if (context.annotations?.length) search.set(KB_NEW_JOB_PARAMS.annotations, context.annotations.join(","));
  if (context.page) search.set(KB_NEW_JOB_PARAMS.page, context.page);
  if (context.sources?.length) search.set(KB_NEW_JOB_PARAMS.sources, context.sources.join(","));
  if (context.message) search.set(KB_NEW_JOB_PARAMS.message, context.message);
  const qs = search.toString();

  return qs ? `?${qs}` : "";
}

function workspaceScoped(slug: string) {
  const ws = `/${encode(slug)}`;
  return {
    root: () => `${ws}/issues`,
    usage: () => `${ws}/usage`,
    issues: () => `${ws}/issues`,
    issueDetail: (id: string) => `${ws}/issues/${encode(id)}`,
    projects: () => `${ws}/projects`,
    projectDetail: (id: string) => `${ws}/projects/${encode(id)}`,
    workflows: () => `${ws}/workflows`,
    autopilots: () => `${ws}/autopilots`,
    autopilotDetail: (id: string) => `${ws}/autopilots/${encode(id)}`,
    agents: () => `${ws}/agents`,
    // Step 1 of agent creation: choose where the agent runs.
    newAgent: () => `${ws}/agents/new`,
    // Step 2: configure the agent on the chosen runtime. A real route so a
    // half-filled form survives a refresh and can be linked to directly.
    newAgentManual: () => `${ws}/agents/new/manual`,
    // Step 3: the agent exists; offer its first uses.
    newAgentDone: (agentId: string) =>
      `${ws}/agents/new/done/${encode(agentId)}`,
    newAgentAi: () => `${ws}/agents/new/ai`,
    // One creation conversation. It is a durable object, not a step of the
    // route above: it survives leaving the studio and is resumed later, so it
    // owns an address instead of being a query param on the "start one" screen.
    newAgentAiSession: (sessionId: string) =>
      `${ws}/agents/new/ai/${encode(sessionId)}`,
    agentDetail: (id: string) => `${ws}/agents/${encode(id)}`,
    // Deep link behind "customize" in a chat's empty state: the agent's
    // General settings, scrolled to the conversation starters that produced
    // the buttons the viewer just looked at.
    agentConversationStarters: (id: string) =>
      `${ws}/agents/${encode(id)}?view=general&focus=${AGENT_FOCUS_CONVERSATION_STARTERS}`,
    memberDetail: (id: string) => `${ws}/members/${encode(id)}`,
    squads: () => `${ws}/squads`,
    squadDetail: (id: string) => `${ws}/squads/${encode(id)}`,
    kb: () => `${ws}/kb`,
    kbBase: (kbSlug: string) => `${ws}/kb/${encode(kbSlug)}`,
    kbNew: () => `${ws}/kb/new`,
    kbNewSession: (sessionId: string) => `${ws}/kb/new/${encode(sessionId)}`,
    kbConfig: (kbSlug: string) => `${ws}/kb/${encode(kbSlug)}/config`,
    kbConfigSession: (kbSlug: string, sessionId: string) =>
      `${ws}/kb/${encode(kbSlug)}/config/${encode(sessionId)}`,
    kbAnnotations: (kbSlug: string) => `${ws}/kb/${encode(kbSlug)}/annotations`,
    kbJobs: (kbSlug: string) => `${ws}/kb/${encode(kbSlug)}/jobs`,
    /** A new job; entry points bring in a starter and its context. */
    kbNewJob: (kbSlug: string, context: KbNewJobContext = {}) =>
      `${ws}/kb/${encode(kbSlug)}/jobs/new${kbNewJobQuery(context)}`,
    kbJob: (kbSlug: string, jobId: string) => `${ws}/kb/${encode(kbSlug)}/jobs/${encode(jobId)}`,
    /** The review list of a knowledge base. */
    kbReviews: (kbSlug: string) => `${ws}/kb/${encode(kbSlug)}/reviews`,
    /** A merge request under review. */
    kbMergeRequest: (kbSlug: string, number: number | string) =>
      `${ws}/kb/${encode(kbSlug)}/reviews/${encode(String(number))}`,
    /** The change log: merged requests, newest first (design 2.7). */
    kbChanges: (kbSlug: string) => `${ws}/kb/${encode(kbSlug)}/changes`,
    kbChange: (kbSlug: string, number: number | string) =>
      `${ws}/kb/${encode(kbSlug)}/changes/${encode(String(number))}`,
    /** Knowledge base management (design 11.x): raw files, export, delete. */
    kbManage: (kbSlug: string, tab: KbManageTab = "raw") =>
      `${ws}/kb/${encode(kbSlug)}/manage${tab === "raw" ? "" : `/${tab}`}`,
    /** The relationship graph of a knowledge base (design 2.10). */
    kbGraph: (kbSlug: string) => `${ws}/kb/${encode(kbSlug)}/graph`,
    kbPage: (kbSlug: string, pageId: string) => `${ws}/kb/${encode(kbSlug)}/p/${encode(pageId)}`,
    kbRevision: (kbSlug: string, pageId: string, revisionId: string) =>
      `${ws}/kb/${encode(kbSlug)}/p/${encode(pageId)}/history/${encode(revisionId)}`,
    inbox: () => `${ws}/inbox`,
    chat: () => `${ws}/chat`,
    chatWithAgent: (agentId: string) =>
      `${ws}/chat?agent=${encode(agentId)}`,
    chatSession: (sessionId: string) =>
      `${ws}/chat?session=${encode(sessionId)}`,
    myIssues: () => `${ws}/my-issues`,
    runtimes: () => `${ws}/runtimes`,
    runtimeDetail: (id: string) => `${ws}/runtimes/${encode(id)}`,
    runtimeSettings: (machineId: string, runtimeId: string) =>
      `${ws}/runtimes/${encode(machineId)}/runtime/${encode(runtimeId)}`,
    skills: () => `${ws}/skills`,
    skillDetail: (id: string) => `${ws}/skills/${encode(id)}`,
    settings: () => `${ws}/settings`,
    attachmentPreview: (id: string) => `${ws}/attachments/${encode(id)}/preview`,
  };
}

export const paths = {
  workspace: workspaceScoped,

  // Global (pre-workspace) routes
  login: () => "/login",
  newWorkspace: () => "/workspaces/new",
  invite: (id: string) => `/invite/${encode(id)}`,
  invitations: () => "/invitations",
  onboarding: () => "/onboarding",
  authCallback: () => "/auth/callback",
  root: () => "/",
};

export type WorkspacePaths = ReturnType<typeof workspaceScoped>;

// Prefixes — not slug names — because we match against full URL paths.
// A path is global if it equals or begins with any of these.
// Note: `/workspaces/` (trailing slash) is the prefix — `workspaces` is reserved,
// so any path starting with `/workspaces/...` is system-owned, not user-owned.
const GLOBAL_PREFIXES = ["/login", "/workspaces/", "/invite/", "/invitations", "/onboarding", "/auth/", "/logout", "/signup"];

export function isGlobalPath(path: string): boolean {
  return GLOBAL_PREFIXES.some((p) => path === p || path.startsWith(p));
}
