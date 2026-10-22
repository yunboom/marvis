import type { Project } from "@marvis/core/types";

export function getProjectIssueMetrics(
  project: Pick<Project, "issue_count" | "done_count">,
) {
  return {
    totalCount: project.issue_count,
    completedCount: project.done_count,
  };
}
