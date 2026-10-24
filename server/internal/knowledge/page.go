package knowledge

import (
	"bytes"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// FrontMatter 是页面 YAML 头里 OKF v0.2 的字段。
type FrontMatter struct {
	Type        string     `yaml:"type" json:"type"`
	Title       string     `yaml:"title" json:"title"`
	Description string     `yaml:"description" json:"description"`
	Domains     []string   `yaml:"domains" json:"domains"`
	Sources     []string   `yaml:"sources" json:"sources"`
	Verified    *Verified  `yaml:"verified" json:"verified"`
	Status      string     `yaml:"status" json:"status"`
	StaleAfter  string     `yaml:"stale_after" json:"stale_after"`
	Generated   *Generated `yaml:"generated" json:"-"`
}

// Verified 记录谁在何时核实过整页论断。
type Verified struct {
	By string `yaml:"by" json:"by"`
	At string `yaml:"at" json:"at"`
}

// Generated 记录页面由谁生成。
type Generated struct {
	By string `yaml:"by"`
	At string `yaml:"at"`
}

// Sentence 是正文里的一句话，也是批注的锚点。
type Sentence struct {
	Text  string `json:"text"`
	Cites []int  `json:"cites"`
}

// Section 是一个标题下的若干段落。
type Section struct {
	Heading    string       `json:"heading"`
	Paragraphs [][]Sentence `json:"paragraphs"`
}

// Footnote 是页面末尾的 `[^n]: uri label`。
type Footnote struct {
	N     int    `json:"n"`
	URI   string `json:"uri"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

// Footnote.Kind 的取值，由 URI 的 scheme 推出。
const (
	SourceTask = "task"
	SourceChat = "chat"
	SourceDoc  = "doc"
	SourcePR   = "pr"
	SourceRepo = "repo"
	SourceWeb  = "web"
	SourceText = "text"
)

// Page 是解析后的知识库页面。
type Page struct {
	Path        string      `json:"path"`
	FrontMatter FrontMatter `json:"front_matter"`
	Title       string      `json:"title"`
	Sections    []Section   `json:"sections"`
	Footnotes   []Footnote  `json:"footnotes"`
	// Links 是正文里指向其他页面的相对链接，已解析为仓库内路径。
	Links []string `json:"links"`
	Body  string   `json:"-"`
	// FrontMatterError 非空表示 YAML 头无法解析。
	FrontMatterError string `json:"-"`
	HasFrontMatter   bool   `json:"-"`
}

var (
	footnoteDefPattern = regexp.MustCompile(`^\[\^(\d+)\]:\s*(.*)$`)
	footnoteRefPattern = regexp.MustCompile(`\[\^(\d+)\]`)
	mdLinkPattern      = regexp.MustCompile(`\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)
	headingPattern     = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	listMarkerPattern  = regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s+`)
)

// ParsePage 解析一个 markdown 页面。p 是仓库内路径，用于解析相对链接。
func ParsePage(p string, content []byte) Page {
	page := Page{Path: p, Sections: []Section{}, Footnotes: []Footnote{}, Links: []string{}}
	body := string(content)

	if strings.HasPrefix(body, "---\n") {
		if end := strings.Index(body[4:], "\n---"); end >= 0 {
			page.HasFrontMatter = true
			raw := body[4 : 4+end]
			if err := yaml.Unmarshal([]byte(raw), &page.FrontMatter); err != nil {
				page.FrontMatterError = err.Error()
			}
			rest := body[4+end+4:]
			body = strings.TrimPrefix(rest, "\n")
		}
	}
	page.Body = body
	page.Title = page.FrontMatter.Title

	cur := Section{Paragraphs: [][]Sentence{}}
	var para []string
	inFence := false
	flushPara := func() {
		if len(para) == 0 {
			return
		}
		text := mdLinkPattern.ReplaceAllString(strings.Join(para, " "), "$1")
		if s := SplitSentences(text); len(s) > 0 {
			cur.Paragraphs = append(cur.Paragraphs, s)
		}
		para = nil
	}
	flushSection := func() {
		flushPara()
		if cur.Heading != "" || len(cur.Paragraphs) > 0 {
			page.Sections = append(page.Sections, cur)
		}
		cur = Section{Paragraphs: [][]Sentence{}}
	}

	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			flushPara()
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if m := footnoteDefPattern.FindStringSubmatch(trimmed); m != nil {
			flushPara()
			n, _ := strconv.Atoi(m[1])
			uri, label := splitFootnote(m[2])
			page.Footnotes = append(page.Footnotes, Footnote{N: n, URI: uri, Label: label, Kind: SourceKind(uri)})
			continue
		}
		if m := headingPattern.FindStringSubmatch(trimmed); m != nil {
			if len(m[1]) == 1 {
				if page.Title == "" {
					page.Title = strings.TrimSpace(m[2])
				}
				continue
			}
			flushSection()
			cur.Heading = strings.TrimSpace(m[2])
			continue
		}
		for _, lm := range mdLinkPattern.FindAllStringSubmatch(trimmed, -1) {
			if target, ok := resolvePageLink(p, lm[2]); ok {
				page.Links = append(page.Links, target)
			}
		}
		switch {
		case trimmed == "":
			flushPara()
		case strings.HasPrefix(trimmed, "|") || strings.HasPrefix(trimmed, ">"):
			flushPara()
			para = append(para, strings.TrimLeft(trimmed, "|> "))
			flushPara()
		case listMarkerPattern.MatchString(line):
			flushPara()
			para = append(para, listMarkerPattern.ReplaceAllString(line, ""))
			flushPara()
		default:
			para = append(para, trimmed)
		}
	}
	flushSection()

	if page.Title == "" {
		page.Title = strings.TrimSuffix(path.Base(p), path.Ext(p))
	}
	page.Links = dedupe(page.Links)

	return page
}

func splitFootnote(rest string) (string, string) {
	rest = strings.TrimSpace(rest)
	if rest == "" {
		return "", ""
	}
	fields := strings.SplitN(rest, " ", 2)
	if strings.Contains(fields[0], "://") || strings.HasPrefix(fields[0], "http") {
		label := ""
		if len(fields) == 2 {
			label = strings.TrimSpace(fields[1])
		}

		return fields[0], label
	}

	return "", rest
}

// SourceKind 由来源 URI 推出来源类型。
func SourceKind(uri string) string {
	switch {
	case strings.HasPrefix(uri, "task://"):
		return SourceTask
	case strings.HasPrefix(uri, "chat://"):
		return SourceChat
	case strings.HasPrefix(uri, "doc://"):
		return SourceDoc
	case strings.HasPrefix(uri, "pr://"):
		return SourcePR
	case strings.HasPrefix(uri, "repo://"):
		return SourceRepo
	case strings.HasPrefix(uri, "http://"), strings.HasPrefix(uri, "https://"):
		return SourceWeb
	default:
		return SourceText
	}
}

func resolvePageLink(from, target string) (string, bool) {
	if strings.Contains(target, "://") || strings.HasPrefix(target, "#") || strings.HasPrefix(target, "mailto:") {
		return "", false
	}
	if i := strings.IndexAny(target, "#?"); i >= 0 {
		target = target[:i]
	}
	if !strings.HasSuffix(target, ".md") {
		return "", false
	}
	resolved := path.Clean(path.Join(path.Dir(from), target))
	if strings.HasPrefix(resolved, "..") || strings.HasPrefix(resolved, "/") {
		return "", false
	}

	return resolved, true
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := in[:0]
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}

	return out
}

// SplitSentences 把一段文字按中英文句末标点切成句子，并提取脚注编号。
func SplitSentences(text string) []Sentence {
	var out []Sentence
	var buf strings.Builder
	runes := []rune(text)
	flush := func() {
		raw := strings.TrimSpace(buf.String())
		buf.Reset()
		if raw == "" {
			return
		}
		var cites []int
		for _, m := range footnoteRefPattern.FindAllStringSubmatch(raw, -1) {
			n, _ := strconv.Atoi(m[1])
			cites = append(cites, n)
		}
		clean := strings.TrimSpace(footnoteRefPattern.ReplaceAllString(raw, ""))
		if clean == "" {
			if len(out) > 0 && len(cites) > 0 {
				out[len(out)-1].Cites = append(out[len(out)-1].Cites, cites...)
			}
			return
		}
		out = append(out, Sentence{Text: clean, Cites: cites})
	}

	for i := 0; i < len(runes); i++ {
		r := runes[i]
		buf.WriteRune(r)
		end := false
		switch r {
		case '。', '！', '？', '；':
			end = true
		case '.', '!', '?':
			end = i+1 == len(runes) || runes[i+1] == ' '
		}
		if !end {
			continue
		}
		// 句末标点后紧跟的脚注属于这一句。
		for i+1 < len(runes) {
			ref := footnoteRefPattern.FindStringIndex(string(runes[i+1:]))
			if ref == nil || ref[0] != 0 {
				break
			}
			n := utf8.RuneCountInString(string(runes[i+1:])[:ref[1]])
			buf.WriteString(string(runes[i+1 : i+1+n]))
			i += n
		}
		flush()
	}
	flush()

	return out
}

// IsStale 判断页面是否已过 stale_after。
func (fm FrontMatter) IsStale(now time.Time) bool {
	if fm.StaleAfter == "" {
		return false
	}
	t, err := time.Parse("2006-01-02", fm.StaleAfter)
	if err != nil {
		return false
	}

	return now.After(t)
}

// Excerpt 返回正文前若干个字符，用作搜索结果摘要。
func Excerpt(body string, max int) string {
	var b bytes.Buffer
	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "[^") || strings.HasPrefix(t, "```") {
			continue
		}
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(footnoteRefPattern.ReplaceAllString(t, ""))
		if utf8.RuneCount(b.Bytes()) >= max {
			break
		}
	}
	r := []rune(b.String())
	if len(r) > max {
		return string(r[:max]) + "…"
	}

	return string(r)
}
