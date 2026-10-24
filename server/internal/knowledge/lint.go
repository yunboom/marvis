package knowledge

import (
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"
)

// LintIssue 是 lint 发现的一个问题。
type LintIssue struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Path     string `json:"path"`
	Message  string `json:"message"`
}

// LintIssue.Severity 的取值。
const (
	SeverityError   = "error"
	SeverityWarning = "warning"
)

// LintIssue.Code 的取值。
const (
	LintBrokenLink         = "broken_link"
	LintOrphanPage         = "orphan_page"
	LintNotInIndex         = "not_in_index"
	LintMissingIndex       = "missing_index"
	LintInvalidFrontMatter = "invalid_front_matter"
	LintMissingField       = "missing_field"
	LintInvalidValue       = "invalid_value"
	LintMissingFootnote    = "missing_footnote"
	LintUnusedFootnote     = "unused_footnote"
	LintMissingClaims      = "missing_claims"
	LintInvalidClaims      = "invalid_claims"
	LintClaimsWithoutPage  = "claims_without_page"
	LintMissingVersion     = "missing_evidence_version"
)

// Lint 检查知识库的结构问题：死链、孤儿页、index 不一致、front matter 缺字段、脚注引用失效与论断文件错误。
// slug 为空时检查所有知识库。结果按路径、问题代码排序。
func (c *Corpus) Lint(slug string) []LintIssue {
	var issues []LintIssue
	add := func(code, severity, p, format string, args ...any) {
		issues = append(issues, LintIssue{Code: code, Severity: severity, Path: p, Message: fmt.Sprintf(format, args...)})
	}
	inScope := func(p string) bool { return slug == "" || SlugOf(p) == slug }

	for p, page := range c.Pages {
		if !inScope(p) {
			continue
		}
		c.lintLinks(page, add)
		lintFrontMatter(page, add)
		lintFootnotes(page, add)

		if len(c.Backlinks(p)) == 0 {
			add(LintOrphanPage, SeverityWarning, p, "no other page links to this page")
		}
		index := c.Indexes[SlugOf(p)]
		if index == nil {
			continue
		}
		if !slices.Contains(index.Links, p) {
			add(LintNotInIndex, SeverityError, p, "page is not linked from %s", index.Path)
		}
	}

	for s, index := range c.Indexes {
		if inScope(s + "/") {
			c.lintLinks(index, add)
		}
	}
	for _, s := range c.slugs() {
		if inScope(s+"/") && c.Indexes[s] == nil && len(c.PagesOf(s)) > 0 {
			add(LintMissingIndex, SeverityError, s+"/"+indexFile, "knowledge base has pages but no %s", indexFile)
		}
	}

	c.lintClaims(inScope, add)

	sort.Slice(issues, func(i, j int) bool {
		if issues[i].Path != issues[j].Path {
			return issues[i].Path < issues[j].Path
		}
		if issues[i].Code != issues[j].Code {
			return issues[i].Code < issues[j].Code
		}

		return issues[i].Message < issues[j].Message
	})

	return issues
}

type addIssue func(code, severity, p, format string, args ...any)

func (c *Corpus) lintLinks(page *Page, add addIssue) {
	for _, l := range page.Links {
		if c.Pages[l] == nil && !c.Others[l] {
			add(LintBrokenLink, SeverityError, page.Path, "link target %s does not exist", l)
		}
	}
}

func lintFrontMatter(page *Page, add addIssue) {
	if !page.HasFrontMatter {
		add(LintInvalidFrontMatter, SeverityError, page.Path, "page has no YAML front matter")
		return
	}
	if page.FrontMatterError != "" {
		add(LintInvalidFrontMatter, SeverityError, page.Path, "front matter is not valid YAML: %s", page.FrontMatterError)
		return
	}

	fm := page.FrontMatter
	required := []struct{ name, value string }{
		{"type", fm.Type}, {"title", fm.Title}, {"description", fm.Description},
	}
	for _, f := range required {
		if strings.TrimSpace(f.value) == "" {
			add(LintMissingField, SeverityError, page.Path, "front matter field %s is missing", f.name)
		}
	}
	if len(fm.Domains) == 0 {
		add(LintMissingField, SeverityError, page.Path, "front matter field domains is missing")
	}
	for _, d := range fm.Domains {
		if !slices.Contains(Domains, d) {
			add(LintInvalidValue, SeverityError, page.Path, "domain %q is not one of %s", d, strings.Join(Domains, ", "))
		}
	}
	if want, ok := groupPageTypes[GroupOf(page.Path)]; ok && fm.Type != "" && fm.Type != want {
		add(LintInvalidValue, SeverityWarning, page.Path, "type %q does not match directory %s (expected %q)", fm.Type, GroupOf(page.Path), want)
	}
	if fm.Status != "" && fm.Status != PageStatusActive && fm.Status != PageStatusDeprecated {
		add(LintInvalidValue, SeverityError, page.Path, "status %q is not %s or %s", fm.Status, PageStatusActive, PageStatusDeprecated)
	}
	if fm.StaleAfter != "" && !validDate(fm.StaleAfter) {
		add(LintInvalidValue, SeverityError, page.Path, "stale_after %q is not a YYYY-MM-DD date", fm.StaleAfter)
	}
}

func lintFootnotes(page *Page, add addIssue) {
	defined := map[int]bool{}
	for _, f := range page.Footnotes {
		defined[f.N] = true
	}

	cited := map[int]bool{}
	for _, sec := range page.Sections {
		for _, para := range sec.Paragraphs {
			for _, s := range para {
				for _, n := range s.Cites {
					cited[n] = true
				}
			}
		}
	}

	for _, n := range sortedKeys(cited) {
		if !defined[n] {
			add(LintMissingFootnote, SeverityError, page.Path, "citation [^%d] has no footnote definition", n)
		}
	}
	for _, n := range sortedKeys(defined) {
		if !cited[n] {
			add(LintUnusedFootnote, SeverityWarning, page.Path, "footnote [^%d] is never cited", n)
		}
	}
}

func (c *Corpus) lintClaims(inScope func(string) bool, add addIssue) {
	for p := range c.Pages {
		if inScope(p) && c.Claims[p] == nil {
			add(LintMissingClaims, SeverityWarning, p, "page has no claims file %s", ClaimsPath(p))
		}
	}

	for pagePath, content := range c.Claims {
		if !inScope(pagePath) {
			continue
		}
		claimsPath := ClaimsPath(pagePath)
		if c.Pages[pagePath] == nil {
			add(LintClaimsWithoutPage, SeverityWarning, claimsPath, "claims file has no page %s", pagePath)
		}
		f, err := ParseClaims(content)
		if err != nil {
			add(LintInvalidClaims, SeverityError, claimsPath, "claims file is not valid JSON: %v", err)
			continue
		}
		for i, cl := range f.Claims {
			if strings.TrimSpace(cl.ID) == "" {
				add(LintInvalidClaims, SeverityError, claimsPath, "claim #%d has no id", i+1)
			}
			for _, ev := range cl.Evidence {
				if ref, ok := ParseRepoURI(ev.URI); ok && ev.Version == "" && ref.Version == "" {
					add(LintMissingVersion, SeverityWarning, claimsPath, "claim %s cites %s without a version", cl.ID, ev.URI)
				}
			}
		}
	}
}

// slugs 返回语料里出现过的知识库目录名。
func (c *Corpus) slugs() []string {
	seen := map[string]bool{}
	for p := range c.Pages {
		seen[SlugOf(p)] = true
	}

	return sortedKeys(seen)
}

func sortedKeys[K int | string](m map[K]bool) []K {
	out := make([]K, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)

	return out
}

func validDate(s string) bool {
	_, err := time.Parse(dateLayout, s)

	return err == nil
}
