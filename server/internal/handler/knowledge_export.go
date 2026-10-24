package handler

import (
	"bytes"
	"net/http"
	"strconv"
)

// ExportKnowledgeBase 下载知识库目录在主线最新提交上的 zip（GET /api/knowledge/bases/{id}/archive）。
// 先写进内存再返回，打包失败时还能回 500；知识库只有 markdown 和少量附件，体积可控。
func (h *Handler) ExportKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	workspaceID, kb, ok := h.requireKnowledgeBaseRead(w, r)
	if !ok {
		return
	}
	head, err := h.Knowledge.Head(r.Context(), workspaceID)
	if err != nil {
		writeKnowledgeError(w, r, err, "failed to read knowledge repository")
		return
	}

	var buf bytes.Buffer
	if err := h.Knowledge.Archive(r.Context(), workspaceID, head, kb.Slug, &buf); err != nil {
		writeKnowledgeError(w, r, err, "failed to export knowledge base")
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+kb.Slug+`.zip"`)
	w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}
