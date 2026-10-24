package handler

import (
	"net/http"
	"net/http/cgi"
	"os/exec"
	"strings"
)

// knowledgeGitPrefix 是 smart HTTP 的路由前缀；客户端统一使用 workspace.git 这个仓库名，
// 工作区由鉴权后的请求上下文决定。
const (
	knowledgeGitPrefix   = "/api/knowledge/git"
	knowledgeGitRepoName = "workspace.git"
)

// KnowledgeGit 提供工作区知识库仓库的 git smart HTTP（clone、fetch、push）。
// 推送只接受 kb/* 分支（仓库的 pre-receive 钩子拒绝其余 ref）。
func (h *Handler) KnowledgeGit(w http.ResponseWriter, r *http.Request) {
	if !h.requireKnowledgeStore(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, knowledgeGitPrefix+"/")
	if !strings.HasPrefix(rest, knowledgeGitRepoName+"/") {
		writeError(w, http.StatusNotFound, "repository not found")
		return
	}
	if err := h.ensureKnowledgeRepo(r.Context(), workspaceID, userID); err != nil {
		writeKnowledgeError(w, r, err, "failed to prepare knowledge repository")
		return
	}
	gitPath, err := exec.LookPath("git")
	if err != nil {
		writeKnowledgeError(w, r, err, "git executable not found")
		return
	}

	// http-backend 按 PATH_INFO 找仓库：把客户端的 workspace.git 换成真实目录名。
	req := r.Clone(r.Context())
	req.URL.Path = knowledgeGitPrefix + "/" + workspaceID + ".git/" + strings.TrimPrefix(rest, knowledgeGitRepoName+"/")
	handler := &cgi.Handler{
		Path: gitPath,
		Args: []string{"http-backend"},
		Root: knowledgeGitPrefix,
		Env: []string{
			"GIT_PROJECT_ROOT=" + h.Knowledge.Root(),
			"GIT_HTTP_EXPORT_ALL=1",
			"REMOTE_USER=" + userID,
		},
	}
	handler.ServeHTTP(w, req)
}
