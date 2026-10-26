import type { QueryClient } from "@tanstack/react-query";
import { kbKeys } from "./queries";

/**
 * Everything an annotation change can move: the lists, the counts on the
 * knowledge base list and home page, and the page's and tree's counters.
 */
export function invalidateKbAnnotations(qc: QueryClient, wsId: string) {
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "annotations"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "home"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "page"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "level"] });
  void qc.invalidateQueries({ queryKey: kbKeys.bases(wsId) });
}

/** Job lists and job pages: a job started, linked, submitted or discarded. */
export function invalidateKbJobs(qc: QueryClient, wsId: string) {
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "jobs"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "job"] });
}

/**
 * A draft took writes: the job pages (their right-hand diff and checks) and
 * every tree level and page read through that draft. Tree and page keys end
 * with the draft they were read through.
 */
export function invalidateKbDraft(qc: QueryClient, wsId: string, draftId: string) {
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "job"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "jobs"] });
  for (const scope of ["level", "page"] as const) {
    void qc.invalidateQueries({
      queryKey: [...kbKeys.all(wsId), scope],
      predicate: (query) => query.queryKey[query.queryKey.length - 1] === draftId,
    });
  }
}

/**
 * A merge request opened: jobs turn read-only, and the home page, knowledge
 * base list and reading pages count it as waiting for review.
 */
export function invalidateKbMergeRequests(qc: QueryClient, wsId: string) {
  invalidateKbJobs(qc, wsId);
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "home"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "page"] });
  void qc.invalidateQueries({ queryKey: kbKeys.bases(wsId) });
}
