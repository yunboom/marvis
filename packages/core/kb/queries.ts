import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type {
  KbAnnotation,
  KbAnnotationStatusFilter,
  KbBuilderMode,
  KbGraph,
  KbStalePage,
  KbRawFileItem,
  KbBuilderSession,
  KbTemplates,
  KbHome,
  KbJob,
  KbJobDetail,
  KbJobState,
  KbMergeRequest,
  KbMergeRequestDetail,
  KbMergeRequestListStatus,
  KbMrComment,
  KbMrCommentState,
  KbMrTimelineEntry,
  KbPage,
  KbRevision,
  KbRevisionDiff,
  KbSearchResult,
  KnowledgeBase,
  KnowledgeBaseDetail,
  KnowledgeBasePending,
} from "../types/kb";

/** Page size of a page tree level; the server caps it at 200. */
export const KB_TREE_PAGE_SIZE = 200;

export const kbKeys = {
  all: (wsId: string) => ["kb", wsId] as const,
  bases: (wsId: string) => [...kbKeys.all(wsId), "bases"] as const,
  /** `kb` is the id or slug the caller addressed the knowledge base by. */
  base: (wsId: string, kb: string) => [...kbKeys.bases(wsId), kb] as const,
  home: (wsId: string, kb: string) => [...kbKeys.all(wsId), "home", kb] as const,
  /** One tree level; an empty parent is the top level, an empty draft the mainline. */
  level: (wsId: string, kb: string, parent: string, draft: string) =>
    [...kbKeys.all(wsId), "level", kb, parent, draft] as const,
  /** A page as read; an empty draft is the mainline. */
  page: (wsId: string, pageId: string, draft: string) =>
    [...kbKeys.all(wsId), "page", pageId, draft] as const,
  history: (wsId: string, pageId: string) => [...kbKeys.all(wsId), "history", pageId] as const,
  revisionDiff: (wsId: string, pageId: string, revisionId: string) =>
    [...kbKeys.history(wsId, pageId), revisionId] as const,
  builderSessions: (wsId: string) => [...kbKeys.all(wsId), "builder-sessions"] as const,
  /** Unfinished builder conversations of one mode; `kb` narrows config ones. */
  builderSessionList: (wsId: string, mode: KbBuilderMode, kb: string) =>
    [...kbKeys.builderSessions(wsId), mode, kb] as const,
  templates: () => ["kb-templates"] as const,
  /** Every annotation list of a knowledge base. */
  annotations: (wsId: string, kb: string) => [...kbKeys.all(wsId), "annotations", kb] as const,
  /** One annotation list; an empty page is every page, `-` the knowledge base level. */
  annotationList: (wsId: string, kb: string, status: KbAnnotationStatusFilter, page: string) =>
    [...kbKeys.annotations(wsId, kb), status, page] as const,
  /** Every search; merges change what they find. */
  searches: (wsId: string) => [...kbKeys.all(wsId), "search"] as const,
  /** One search; an empty kb searches every knowledge base. */
  search: (wsId: string, kb: string, q: string, type: string, limit: number) =>
    [...kbKeys.searches(wsId), kb, q, type, limit] as const,
  /** Every job list of a knowledge base. */
  jobs: (wsId: string, kb: string) => [...kbKeys.all(wsId), "jobs", kb] as const,
  /** One job list; an empty state lists every job. */
  jobList: (wsId: string, kb: string, state: KbJobListState | "") => [...kbKeys.jobs(wsId, kb), state] as const,
  /** A job with its draft's changes and checks. */
  job: (wsId: string, jobId: string) => [...kbKeys.all(wsId), "job", jobId] as const,
  /** Every merge request list (the review list and the change log). */
  reviews: (wsId: string) => [...kbKeys.all(wsId), "reviews"] as const,
  /** One merge request list; an empty kb lists every knowledge base. */
  reviewList: (wsId: string, kb: string, status: KbMergeRequestListStatus) =>
    [...kbKeys.reviews(wsId), kb, status] as const,
  /** One merge request by its workspace number, and its comments under it. */
  review: (wsId: string, number: number) => [...kbKeys.all(wsId), "review", number] as const,
  /** One merge request by id, as a mention card reads it; refreshed with the reviews. */
  reviewById: (wsId: string, id: string) => [...kbKeys.all(wsId), "review", "id", id] as const,
  /** One annotation by id, as a mention card reads it. */
  annotation: (wsId: string, id: string) => [...kbKeys.all(wsId), "annotation", id] as const,
  reviewComments: (wsId: string, number: number, state: KbMrCommentState = "published") =>
    [...kbKeys.review(wsId, number), "comments", state] as const,
  /** Comments and events of a merge request, under it so its refreshes cover them. */
  reviewTimeline: (wsId: string, number: number, state: KbMrCommentState = "published") =>
    [...kbKeys.review(wsId, number), "timeline", state] as const,
  /** Raw files of a knowledge base. */
  raws: (wsId: string, kb: string) => [...kbKeys.all(wsId), "raws", kb] as const,
  /** The relationship graph; merges change it. */
  graph: (wsId: string, kb: string) => [...kbKeys.all(wsId), "graph", kb] as const,
  stale: (wsId: string, kb: string) => [...kbKeys.all(wsId), "stale", kb] as const,
};

/** How many merge requests the review list and the change log show. */
export const KB_REVIEW_LIST_LIMIT = 100;

/** Merge requests of a knowledge base, most recently updated first. */
export function kbMergeRequestListOptions(wsId: string, kb: string, status: KbMergeRequestListStatus) {
  return queryOptions<KbMergeRequest[]>({
    queryKey: kbKeys.reviewList(wsId, kb, status),
    queryFn: () => api.listKnowledgeBaseMergeRequests({ status, kb: kb || undefined, limit: KB_REVIEW_LIST_LIMIT }),
    enabled: !!wsId,
  });
}

/** A merge request with its file cards and checks; draft writes refresh it. */
export function kbMergeRequestOptions(wsId: string, number: number) {
  return queryOptions<KbMergeRequestDetail>({
    queryKey: kbKeys.review(wsId, number),
    queryFn: () => api.getKnowledgeBaseMergeRequest(number),
    enabled: !!wsId && number > 0,
  });
}

/** A merge request addressed by id (a `mention://kb_mr/<id>` link). */
export function kbMergeRequestByIdOptions(wsId: string, id: string) {
  return queryOptions<KbMergeRequestDetail>({
    queryKey: kbKeys.reviewById(wsId, id),
    queryFn: () => api.getKnowledgeBaseMergeRequest(id),
    enabled: !!wsId && !!id,
  });
}

/** One annotation (a `mention://kb_annotation/<id>` link). */
export function kbAnnotationOptions(wsId: string, id: string) {
  return queryOptions<KbAnnotation>({
    queryKey: kbKeys.annotation(wsId, id),
    queryFn: () => api.getKnowledgeBaseAnnotation(id),
    enabled: !!wsId && !!id,
  });
}

/** Published comments; `all` adds the viewer's pending review comments. */
export function kbMrCommentListOptions(wsId: string, number: number, state: KbMrCommentState = "published") {
  return queryOptions<KbMrComment[]>({
    queryKey: kbKeys.reviewComments(wsId, number, state),
    queryFn: () => api.listKnowledgeBaseMrComments(number, state),
    enabled: !!wsId && number > 0,
  });
}

/** The review page's activity: comments and events, oldest first. */
export function kbMrTimelineOptions(wsId: string, number: number, state: KbMrCommentState = "published") {
  return queryOptions<KbMrTimelineEntry[]>({
    queryKey: kbKeys.reviewTimeline(wsId, number, state),
    queryFn: () => api.listKnowledgeBaseMrTimeline(number, state),
    enabled: !!wsId && number > 0,
  });
}

/** Raw files of a knowledge base, newest first. */
export function kbRawFileListOptions(wsId: string, kb: string) {
  return queryOptions<KbRawFileItem[]>({
    queryKey: kbKeys.raws(wsId, kb),
    queryFn: () => api.listKnowledgeBaseRawFiles(kb),
    enabled: !!wsId && !!kb,
  });
}

/** Pages and links of a knowledge base; kb.mr.merged refreshes it. */
/** Pages past their review date. */
export function kbStalePagesOptions(wsId: string, kb: string) {
  return queryOptions<KbStalePage[]>({
    queryKey: kbKeys.stale(wsId, kb),
    queryFn: () => api.listKnowledgeBaseStalePages(kb),
    enabled: !!wsId && !!kb,
  });
}

export function kbGraphOptions(wsId: string, kb: string) {
  return queryOptions<KbGraph>({
    queryKey: kbKeys.graph(wsId, kb),
    queryFn: () => api.getKnowledgeBaseGraph(kb),
    enabled: !!wsId && !!kb,
  });
}

/** The job list filters the server takes. */
export type KbJobListState = Extract<KbJobState, "running" | "failed">;

/** The caller's jobs of a knowledge base. */
export function kbJobListOptions(wsId: string, kb: string, state: KbJobListState | "" = "") {
  return queryOptions<KbJob[]>({
    queryKey: kbKeys.jobList(wsId, kb, state),
    queryFn: () => api.listKnowledgeBaseJobs(kb, { state: state || undefined }),
    enabled: !!wsId && !!kb,
  });
}

/** A job and its draft; draft writes refresh it through kb.draft.updated. */
export function kbJobOptions(wsId: string, jobId: string) {
  return queryOptions<KbJobDetail>({
    queryKey: kbKeys.job(wsId, jobId),
    queryFn: () => api.getKnowledgeBaseJob(jobId),
    enabled: !!wsId && !!jobId,
  });
}

/** Hits shown in a search dropdown. */
export const KB_SEARCH_LIMIT = 10;

/** Search mainline pages; `q` is trimmed and an empty one does not run. */
export function kbSearchOptions(wsId: string, q: string, { kb = "", type = "", limit = KB_SEARCH_LIMIT } = {}) {
  const query = q.trim();
  return queryOptions<KbSearchResult>({
    queryKey: kbKeys.search(wsId, kb, query, type, limit),
    queryFn: () => api.searchKnowledgeBases({ q: query, kb: kb || undefined, type: type || undefined, limit }),
    enabled: !!wsId && query !== "",
  });
}

export function kbBuilderSessionListOptions(wsId: string, mode: KbBuilderMode, kb = "") {
  return queryOptions<KbBuilderSession[]>({
    queryKey: kbKeys.builderSessionList(wsId, mode, kb),
    queryFn: () => api.listKbBuilderSessions({ mode, kb: kb || undefined }),
    enabled: !!wsId && (mode === "create" || !!kb),
    // Changes through work on other screens (starting, sending, creating), and
    // the banner mounts on demand: never trust a cached copy.
    staleTime: 0,
  });
}

/** The built-in templates only change with a deploy. */
export function kbTemplatesOptions() {
  return queryOptions<KbTemplates>({
    queryKey: kbKeys.templates(),
    queryFn: () => api.getKnowledgeBaseTemplates(),
  });
}

export function kbBaseListOptions(wsId: string) {
  return queryOptions<KnowledgeBase[]>({
    queryKey: kbKeys.bases(wsId),
    queryFn: () => api.listKnowledgeBases(),
    enabled: !!wsId,
  });
}

export function kbBaseDetailOptions(wsId: string, kb: string) {
  return queryOptions<KnowledgeBaseDetail>({
    queryKey: kbKeys.base(wsId, kb),
    queryFn: () => api.getKnowledgeBase(kb),
    enabled: !!wsId && !!kb,
  });
}

export function kbHomeOptions(wsId: string, kb: string) {
  return queryOptions<KbHome>({
    queryKey: kbKeys.home(wsId, kb),
    queryFn: () => api.getKnowledgeBaseHome(kb),
    enabled: !!wsId && !!kb,
  });
}

/** One tree level, fetched cursor page by cursor page. */
export function kbTreeLevelOptions(wsId: string, kb: string, parent: string, draft: string) {
  return infiniteQueryOptions({
    queryKey: kbKeys.level(wsId, kb, parent, draft),
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api.listKnowledgeBasePages(kb, {
        parent: parent || undefined,
        cursor: pageParam || undefined,
        limit: KB_TREE_PAGE_SIZE,
        draft: draft || undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.next_cursor || undefined,
    enabled: !!wsId && !!kb,
  });
}

export function kbPageOptions(wsId: string, pageId: string, draft: string) {
  return queryOptions<KbPage>({
    queryKey: kbKeys.page(wsId, pageId, draft),
    queryFn: () => api.getKnowledgeBasePage(pageId, draft || undefined),
    enabled: !!wsId && !!pageId,
  });
}

export function kbPageHistoryOptions(wsId: string, pageId: string) {
  return queryOptions<KbRevision[]>({
    queryKey: kbKeys.history(wsId, pageId),
    queryFn: () => api.listKnowledgeBasePageHistory(pageId),
    enabled: !!wsId && !!pageId,
  });
}

export function kbRevisionDiffOptions(wsId: string, pageId: string, revisionId: string) {
  return queryOptions<KbRevisionDiff>({
    queryKey: kbKeys.revisionDiff(wsId, pageId, revisionId),
    queryFn: () => api.getKnowledgeBaseRevisionDiff(pageId, revisionId),
    enabled: !!wsId && !!pageId && !!revisionId,
  });
}

/** Annotations of a knowledge base, newest first. */
export function kbAnnotationListOptions(wsId: string, kb: string, status: KbAnnotationStatusFilter, page = "") {
  return queryOptions<KbAnnotation[]>({
    queryKey: kbKeys.annotationList(wsId, kb, status, page),
    queryFn: () => api.listKnowledgeBaseAnnotations(kb, { status, page: page || undefined }),
    enabled: !!wsId && !!kb,
  });
}

/** Annotations still waiting on someone: pending or held by a merge request. */
export function isOpenAnnotation(annotation: KbAnnotation): boolean {
  return annotation.status === "pending" || annotation.status === "processing";
}

/** Merge requests waiting for review across the given knowledge bases. */
export function countOpenMergeRequests(bases: readonly KnowledgeBase[]): number {
  let total = 0;
  for (const base of bases) total += base.pending.open_mrs;
  return total;
}

/** Work waiting in one knowledge base: open reviews, open annotations and pages to re-check. */
export function countKbPending(pending: KnowledgeBasePending): number {
  return pending.open_mrs + pending.annotations + pending.stale_pages;
}
