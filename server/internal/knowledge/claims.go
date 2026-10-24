package knowledge

import (
	"encoding/json"
	"strings"

	"github.com/pkg/errors"
)

// Evidence 是论断的一条证据：来源 URI 与核对时的版本（代码仓库为提交号）。
type Evidence struct {
	URI     string `json:"uri"`
	Version string `json:"version,omitempty"`
}

// Claim 是页面里一句事实性陈述及其证据。
type Claim struct {
	ID       string     `json:"id"`
	Text     string     `json:"text"`
	Evidence []Evidence `json:"evidence"`
}

// ClaimsFile 是 .claims/<页面路径>.json 的内容。
type ClaimsFile struct {
	Claims []Claim `json:"claims"`
}

// ParseClaims 解析论断文件。
func ParseClaims(content []byte) (ClaimsFile, error) {
	var f ClaimsFile
	if err := json.Unmarshal(content, &f); err != nil {
		return ClaimsFile{}, errors.WithStack(err)
	}

	return f, nil
}

// RepoRef 是 repo:// 来源指向的代码位置。
type RepoRef struct {
	Repo    string
	Path    string
	Version string
}

const repoScheme = "repo://"

// ParseRepoURI 解析 repo://<repo>/<path>#L<a>-L<b>@<commit>；行号与 @commit 都可省略。
func ParseRepoURI(uri string) (RepoRef, bool) {
	rest, ok := strings.CutPrefix(uri, repoScheme)
	if !ok {
		return RepoRef{}, false
	}

	var ref RepoRef
	if i := strings.LastIndex(rest, "@"); i >= 0 {
		ref.Version = rest[i+1:]
		rest = rest[:i]
	}
	if i := strings.Index(rest, "#"); i >= 0 {
		rest = rest[:i]
	}
	repo, p, ok := strings.Cut(rest, "/")
	if !ok || repo == "" || p == "" {
		return RepoRef{}, false
	}
	ref.Repo, ref.Path = repo, p

	return ref, true
}
