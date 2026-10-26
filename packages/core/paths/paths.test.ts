import { describe, it, expect } from "vitest";
import { paths, isGlobalPath } from "./paths";

describe("paths.workspace(slug)", () => {
  const ws = paths.workspace("acme");

  it("builds workspace paths with slug prefix", () => {
    expect(ws.usage()).toBe("/acme/usage");
    expect(ws.issues()).toBe("/acme/issues");
    expect(ws.issueDetail("abc-123")).toBe("/acme/issues/abc-123");
    expect(ws.projects()).toBe("/acme/projects");
    expect(ws.projectDetail("p1")).toBe("/acme/projects/p1");
    expect(ws.autopilots()).toBe("/acme/autopilots");
    expect(ws.autopilotDetail("a1")).toBe("/acme/autopilots/a1");
    expect(ws.agents()).toBe("/acme/agents");
    expect(ws.newAgent()).toBe("/acme/agents/new");
    expect(ws.newAgentAi()).toBe("/acme/agents/new/ai");
    expect(ws.newAgentAiSession("sess_1")).toBe("/acme/agents/new/ai/sess_1");
    expect(ws.newAgentDone("agent_1")).toBe("/acme/agents/new/done/agent_1");
    expect(ws.memberDetail("u1")).toBe("/acme/members/u1");
    expect(ws.inbox()).toBe("/acme/inbox");
    expect(ws.chatWithAgent("agent one")).toBe(
      "/acme/chat?agent=agent%20one",
    );
    expect(ws.chatSession("session one")).toBe(
      "/acme/chat?session=session%20one",
    );
    expect(ws.myIssues()).toBe("/acme/my-issues");
    expect(ws.runtimes()).toBe("/acme/runtimes");
    expect(ws.runtimeSettings("machine/runtime", "runtime one")).toBe(
      "/acme/runtimes/machine%2Fruntime/runtime/runtime%20one",
    );
    expect(ws.skills()).toBe("/acme/skills");
    expect(ws.skillDetail("skl_123")).toBe("/acme/skills/skl_123");
    expect(ws.squads()).toBe("/acme/squads");
    expect(ws.squadDetail("sq_1")).toBe("/acme/squads/sq_1");
    expect(ws.kb()).toBe("/acme/kb");
    expect(ws.kbBase("team docs")).toBe("/acme/kb/team%20docs");
    expect(ws.kbNew()).toBe("/acme/kb/new");
    expect(ws.kbNewSession("s 1")).toBe("/acme/kb/new/s%201");
    expect(ws.kbConfig("team")).toBe("/acme/kb/team/config");
    expect(ws.kbConfigSession("team", "s1")).toBe("/acme/kb/team/config/s1");
    expect(ws.kbPage("team", "p 1")).toBe("/acme/kb/team/p/p%201");
    expect(ws.kbAnnotations("team")).toBe("/acme/kb/team/annotations");
    expect(ws.kbJobs("team")).toBe("/acme/kb/team/jobs");
    expect(ws.kbJob("team", "j1")).toBe("/acme/kb/team/jobs/j1");
    expect(ws.kbNewJob("team")).toBe("/acme/kb/team/jobs/new");
    expect(ws.kbNewJob("team", { starter: "annotations", annotations: ["a1", "a2"], message: "处理 4 条" })).toBe(
      "/acme/kb/team/jobs/new?starter=annotations&annotations=a1%2Ca2&message=%E5%A4%84%E7%90%86+4+%E6%9D%A1",
    );
    expect(ws.kbMergeRequest("team", 16)).toBe("/acme/kb/team/reviews/16");
    expect(ws.kbReviews("team")).toBe("/acme/kb/team/reviews");
    expect(ws.kbChanges("team")).toBe("/acme/kb/team/changes");
    expect(ws.kbChange("team", 15)).toBe("/acme/kb/team/changes/15");
    expect(ws.kbManage("team")).toBe("/acme/kb/team/manage");
    expect(ws.kbManage("team", "export")).toBe("/acme/kb/team/manage/export");
    expect(ws.kbGraph("team")).toBe("/acme/kb/team/graph");
    expect(ws.kbRevision("team", "p1", "r1")).toBe("/acme/kb/team/p/p1/history/r1");
    expect(ws.settings()).toBe("/acme/settings");
    expect(ws.attachmentPreview("att_42")).toBe("/acme/attachments/att_42/preview");
  });

  it("URL-encodes special characters in ids", () => {
    expect(ws.issueDetail("id with space")).toBe("/acme/issues/id%20with%20space");
  });
});

describe("paths (global)", () => {
  it("builds global paths without slug", () => {
    expect(paths.login()).toBe("/login");
    expect(paths.newWorkspace()).toBe("/workspaces/new");
    expect(paths.invite("inv-1")).toBe("/invite/inv-1");
    expect(paths.authCallback()).toBe("/auth/callback");
  });
});

describe("isGlobalPath", () => {
  it("returns true for pre-workspace routes", () => {
    expect(isGlobalPath("/login")).toBe(true);
    expect(isGlobalPath("/workspaces/new")).toBe(true);
    expect(isGlobalPath("/invite/abc")).toBe(true);
    expect(isGlobalPath("/auth/callback")).toBe(true);
  });

  it("returns false for workspace-scoped paths", () => {
    expect(isGlobalPath("/acme/issues")).toBe(false);
    expect(isGlobalPath("/")).toBe(false);
  });
});
