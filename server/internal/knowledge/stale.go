package knowledge

import (
	"sort"
	"time"

	"github.com/pkg/errors"
)

// StaleItem 是一条可能过期、需要重新核对的内容。
type StaleItem struct {
	Path    string `json:"path"`
	Reason  string `json:"reason"`
	ClaimID string `json:"claim_id,omitempty"`
	Claim   string `json:"claim,omitempty"`
	URI     string `json:"uri,omitempty"`
	Version string `json:"version,omitempty"`
}

// StaleItem.Reason 的取值。
const (
	// StaleExpired 表示页面已过 stale_after。
	StaleExpired = "expired"
	// StaleChanged 表示证据文件在核对版本之后被修改或删除。
	StaleChanged = "changed"
	// StaleUnknownVersion 表示代码仓库里找不到证据记录的版本。
	StaleUnknownVersion = "unknown_version"
	// StaleUnchecked 表示没有提供证据所在的代码仓库，无法比对。
	StaleUnchecked = "unchecked"
)

// RepoDiffer 比对一个代码仓库的当前版本与历史版本。
type RepoDiffer interface {
	// ChangedSince 返回 version 之后被修改或删除的文件（仓库内路径）；known=false 表示仓库里没有这个版本。
	ChangedSince(version string) (changed map[string]bool, known bool, err error)
}

type repoVersion struct{ repo, version string }

type versionDiff struct {
	changed map[string]bool
	known   bool
}

// Stale 找出需要重新核对的内容：过了 stale_after 的页面，以及 repo:// 证据在核对版本之后被改动的论断。
// repos 按 repo:// 里的仓库名索引；没提供的仓库记为 unchecked。非代码来源的证据不参与比对。
// 无法解析的论断文件由 Lint 报告，这里跳过。
func (c *Corpus) Stale(slug string, now time.Time, repos map[string]RepoDiffer) ([]StaleItem, error) {
	var items []StaleItem
	diffs := map[repoVersion]versionDiff{}

	for _, p := range c.sortedPagePaths(slug) {
		if c.Pages[p].FrontMatter.IsStale(now) {
			items = append(items, StaleItem{Path: p, Reason: StaleExpired, Version: c.Pages[p].FrontMatter.StaleAfter})
		}

		f, err := ParseClaims(c.Claims[p])
		if c.Claims[p] == nil || err != nil {
			continue
		}
		for _, cl := range f.Claims {
			for _, ev := range cl.Evidence {
				ref, ok := ParseRepoURI(ev.URI)
				if !ok {
					continue
				}
				version := ev.Version
				if version == "" {
					version = ref.Version
				}
				item := StaleItem{Path: p, ClaimID: cl.ID, Claim: cl.Text, URI: ev.URI, Version: version}

				differ := repos[ref.Repo]
				if differ == nil || version == "" {
					item.Reason = StaleUnchecked
					items = append(items, item)
					continue
				}

				// 同一仓库同一版本只比对一次，论断再多也只调用一次 git。
				key := repoVersion{ref.Repo, version}
				d, seen := diffs[key]
				if !seen {
					changed, known, err := differ.ChangedSince(version)
					if err != nil {
						return nil, errors.Wrapf(err, "diff repo=%s version=%s", ref.Repo, version)
					}
					d = versionDiff{changed: changed, known: known}
					diffs[key] = d
				}

				switch {
				case !d.known:
					item.Reason = StaleUnknownVersion
				case d.changed[ref.Path]:
					item.Reason = StaleChanged
				default:
					continue
				}
				items = append(items, item)
			}
		}
	}

	return items, nil
}

func (c *Corpus) sortedPagePaths(slug string) []string {
	var out []string
	for p := range c.Pages {
		if slug == "" || SlugOf(p) == slug {
			out = append(out, p)
		}
	}
	sort.Strings(out)

	return out
}
