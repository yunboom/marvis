// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import {
  EMPTY_KB_GRAPH,
  EMPTY_KB_RAW_FILE_LIST,
  EMPTY_KB_RAW_UPLOAD,
  KB_DELETE_RESULT_FALLBACK,
  KbDeleteResultSchema,
  KbGraphSchema,
  KbRawFileListSchema,
  KbRawUploadSchema,
} from "./kb-schemas";

const opts = { endpoint: "test" };

const rawRow = {
  id: "raw-1",
  kind: "source",
  name: "渠道接入规范 v3.pdf",
  uri: "raw://sources/渠道接入规范 v3.pdf",
  content_type: "application/pdf",
  size: 482113,
  uploaded_by: "user-1",
  uploaded_by_name: "王芳",
  created_at: "2026-10-08T10:12:00Z",
  cited_pages: 3,
};

describe("raw file schemas", () => {
  it("reads a list and defaults what is missing", () => {
    const parsed = parseWithFallback(
      [rawRow, { id: "raw-2", kind: "video", size: "big" }, { name: "no id" }, 4],
      KbRawFileListSchema,
      EMPTY_KB_RAW_FILE_LIST,
      opts,
    );
    expect(parsed[0]).toEqual(rawRow);
    expect(parsed[1]).toMatchObject({ id: "raw-2", kind: "source", size: 0, name: "", cited_pages: 0 });
    expect(parsed).toHaveLength(2);
  });

  it("falls back to no files for a broken body", () => {
    expect(parseWithFallback({ error: "boom" }, KbRawFileListSchema, EMPTY_KB_RAW_FILE_LIST, opts)).toEqual([]);
  });

  it("reads an upload as its files", () => {
    const file = { id: "raw-1", kind: "asset", name: "flow.png", uri: "raw://assets/flow.png", size: 10 };
    expect(parseWithFallback({ files: [file, { name: "x" }] }, KbRawUploadSchema, EMPTY_KB_RAW_UPLOAD, opts)).toEqual([file]);
    expect(parseWithFallback({ files: null }, KbRawUploadSchema, EMPTY_KB_RAW_UPLOAD, opts)).toEqual([]);
  });
});

describe("graph schema", () => {
  it("reads nodes and edges, missing pages with a null id", () => {
    const graph = {
      nodes: [
        { key: "p1", id: "p1", title: "支付回调", path: "/payment/callback", group: "支付", degree: 1, missing: false },
        { key: "/payment/refund", id: null, title: "/payment/refund", path: "/payment/refund", group: "支付", degree: 1, missing: true },
      ],
      edges: [{ from: "p1", to: "/payment/refund" }],
    };
    expect(parseWithFallback(graph, KbGraphSchema, EMPTY_KB_GRAPH, opts)).toEqual(graph);
  });

  it("drops malformed nodes and edges that point at them", () => {
    const parsed = parseWithFallback(
      { nodes: [{ key: "p1", degree: "x" }, { title: "no key" }], edges: [{ from: "p1", to: "gone" }, { from: "p1" }] },
      KbGraphSchema,
      EMPTY_KB_GRAPH,
      opts,
    );
    expect(parsed.nodes).toEqual([{ key: "p1", id: null, title: "", path: "", group: "", degree: 0, missing: false }]);
    expect(parsed.edges).toEqual([]);
    expect(parseWithFallback("nope", KbGraphSchema, EMPTY_KB_GRAPH, opts)).toEqual(EMPTY_KB_GRAPH);
  });
});

describe("delete schema", () => {
  it("reads the closed merge requests", () => {
    expect(parseWithFallback({ deleted: true, closed_mrs: [16, "x"] }, KbDeleteResultSchema, KB_DELETE_RESULT_FALLBACK, opts)).toEqual({
      deleted: true,
      closed_mrs: [16],
    });
    expect(parseWithFallback(null, KbDeleteResultSchema, KB_DELETE_RESULT_FALLBACK, opts)).toEqual(KB_DELETE_RESULT_FALLBACK);
  });
});
