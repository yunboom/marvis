import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type {
  KbAnnotation,
  KbAnnotationStatusFilter,
  KbBuilderMode,
  KbBuilderSession,
  KbTemplates,
  KbHome,
  KbPage,
  KbRevision,
  KbRevisionDiff,
  KbSearchResult,
  KnowledgeBase,
  KnowledgeBaseDetail,
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
};

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
