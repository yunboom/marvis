package knowledge

import (
	"context"
	"math"
	"sort"
	"strings"
	"sync"
	"unicode"
)

// Corpus 是某个提交下工作区所有知识库页面的解析结果。
type Corpus struct {
	Commit string
	// Pages 按仓库路径索引，只包含各知识库 wiki/ 下的 markdown 页面。
	Pages map[string]*Page
	// Others 是 wiki/ 之外的保留文件（index.md、overview.md 等）的路径。
	Others map[string]bool
	// Claims 按页面路径索引论断文件的原始内容。
	Claims map[string][]byte

	index *searchIndex
}

const corpusCacheSize = 32

type corpusCache struct {
	mu    sync.Mutex
	order []string
	items map[string]*Corpus
}

var corpora = &corpusCache{items: map[string]*Corpus{}}

func (c *corpusCache) get(key string) *Corpus {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.items[key]
}

func (c *corpusCache) put(key string, v *Corpus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.items[key]; !ok {
		c.order = append(c.order, key)
		if len(c.order) > corpusCacheSize {
			delete(c.items, c.order[0])
			c.order = c.order[1:]
		}
	}
	c.items[key] = v
}

// IsPagePath 判断仓库路径是否是知识库页面（<slug>/wiki/**.md）。
func IsPagePath(p string) bool {
	parts := strings.SplitN(p, "/", 3)

	return len(parts) == 3 && parts[1] == "wiki" && strings.HasSuffix(p, ".md")
}

// SlugOf 返回仓库路径所属的知识库目录名。
func SlugOf(p string) string {
	if i := strings.Index(p, "/"); i > 0 {
		return p[:i]
	}

	return ""
}

// ClaimsPath 返回页面对应的论断文件路径：<slug>/.claims/<页面在库内的路径>.json。
func ClaimsPath(pagePath string) string {
	slug := SlugOf(pagePath)

	return slug + "/.claims/" + strings.TrimPrefix(pagePath, slug+"/") + ".json"
}

// LoadCorpus 读取并解析 commit 下的全部页面，结果按提交缓存。
func (s *Store) LoadCorpus(ctx context.Context, workspaceID, commit string) (*Corpus, error) {
	key := workspaceID + "@" + commit
	if c := corpora.get(key); c != nil {
		return c, nil
	}

	files, err := s.ListFiles(ctx, workspaceID, commit, "")
	if err != nil {
		return nil, err
	}
	var pagePaths, claimPaths []string
	others := map[string]bool{}
	for _, f := range files {
		switch {
		case IsPagePath(f):
			pagePaths = append(pagePaths, f)
		case strings.Contains(f, "/.claims/") && strings.HasSuffix(f, ".json"):
			claimPaths = append(claimPaths, f)
		default:
			others[f] = true
		}
	}
	contents, err := s.ReadFiles(ctx, workspaceID, commit, append(pagePaths, claimPaths...))
	if err != nil {
		return nil, err
	}

	c := &Corpus{Commit: commit, Pages: make(map[string]*Page, len(pagePaths)), Others: others, Claims: map[string][]byte{}}
	for _, p := range pagePaths {
		page := ParsePage(p, contents[p])
		c.Pages[p] = &page
	}
	for _, p := range claimPaths {
		pagePath := strings.TrimSuffix(strings.Replace(p, "/.claims/", "/", 1), ".json")
		c.Claims[pagePath] = contents[p]
	}
	c.index = buildSearchIndex(c.Pages)
	corpora.put(key, c)

	return c, nil
}

// PagesOf 返回某个知识库的页面，按路径排序。
func (c *Corpus) PagesOf(slug string) []*Page {
	var out []*Page
	for p, page := range c.Pages {
		if SlugOf(p) == slug {
			out = append(out, page)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })

	return out
}

// Backlinks 返回链接到 target 的页面路径。
func (c *Corpus) Backlinks(target string) []string {
	var out []string
	for p, page := range c.Pages {
		for _, l := range page.Links {
			if l == target && p != target {
				out = append(out, p)
				break
			}
		}
	}
	sort.Strings(out)

	return out
}

// GroupOf 返回页面所在的分类目录（entities、concepts 等）。
func GroupOf(pagePath string) string {
	parts := strings.SplitN(pagePath, "/", 4)
	if len(parts) >= 4 {
		return parts[2]
	}

	return ""
}

// GraphEdge 是两个页面之间的链接。
type GraphEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Graph 返回某个知识库内页面之间的链接（只保留两端都在库内的边）。
func (c *Corpus) Graph(slug string) []GraphEdge {
	var edges []GraphEdge
	for _, page := range c.PagesOf(slug) {
		for _, l := range page.Links {
			if _, ok := c.Pages[l]; ok && SlugOf(l) == slug && l != page.Path {
				edges = append(edges, GraphEdge{From: page.Path, To: l})
			}
		}
	}

	return edges
}

// SearchHit 是一条搜索结果。
type SearchHit struct {
	Path    string  `json:"path"`
	Slug    string  `json:"slug"`
	Title   string  `json:"title"`
	Excerpt string  `json:"excerpt"`
	Score   float64 `json:"score"`
}

type searchIndex struct {
	docs   []string
	tf     []map[string]int
	length []int
	df     map[string]int
	avgLen float64
}

// Tokenize 把文本切成检索词：ASCII 单词小写，中日韩文字按二元切分（单字也保留）。
func Tokenize(text string) []string {
	var tokens []string
	var word []rune
	var cjk []rune
	flushWord := func() {
		if len(word) > 0 {
			tokens = append(tokens, strings.ToLower(string(word)))
			word = word[:0]
		}
	}
	flushCJK := func() {
		switch len(cjk) {
		case 0:
		case 1:
			tokens = append(tokens, string(cjk))
		default:
			for i := 0; i+1 < len(cjk); i++ {
				tokens = append(tokens, string(cjk[i:i+2]))
			}
		}
		cjk = cjk[:0]
	}
	for _, r := range text {
		switch {
		case unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r):
			flushWord()
			cjk = append(cjk, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			flushCJK()
			word = append(word, r)
		default:
			flushWord()
			flushCJK()
		}
	}
	flushWord()
	flushCJK()

	return tokens
}

func buildSearchIndex(pages map[string]*Page) *searchIndex {
	idx := &searchIndex{df: map[string]int{}}
	total := 0
	for p, page := range pages {
		// 标题权重加倍：标题文本计入两次。
		tokens := Tokenize(page.Title + " " + page.Title + " " + page.FrontMatter.Description + " " + page.Body)
		tf := map[string]int{}
		for _, t := range tokens {
			tf[t]++
		}
		for t := range tf {
			idx.df[t]++
		}
		idx.docs = append(idx.docs, p)
		idx.tf = append(idx.tf, tf)
		idx.length = append(idx.length, len(tokens))
		total += len(tokens)
	}
	if len(idx.docs) > 0 {
		idx.avgLen = float64(total) / float64(len(idx.docs))
	}

	return idx
}

// Search 用 BM25 在全部知识库（slug 非空时只在该库）里检索，返回前 limit 条。
func (c *Corpus) Search(query, slug string, limit int) []SearchHit {
	const k1, b = 1.2, 0.75
	terms := dedupe(Tokenize(query))
	if len(terms) == 0 || c.index == nil {
		return []SearchHit{}
	}

	n := float64(len(c.index.docs))
	hits := []SearchHit{}
	for i, p := range c.index.docs {
		if slug != "" && SlugOf(p) != slug {
			continue
		}
		score := 0.0
		matched := 0
		for _, t := range terms {
			f := float64(c.index.tf[i][t])
			if f == 0 {
				continue
			}
			matched++
			df := float64(c.index.df[t])
			idf := math.Log(1 + (n-df+0.5)/(df+0.5))
			score += idf * f * (k1 + 1) / (f + k1*(1-b+b*float64(c.index.length[i])/c.index.avgLen))
		}
		// 中文二元切分噪声大：要求至少命中一半检索词。
		if score <= 0 || matched*2 < len(terms) {
			continue
		}
		page := c.Pages[p]
		hits = append(hits, SearchHit{Path: p, Slug: SlugOf(p), Title: page.Title, Excerpt: Excerpt(page.Body, 80), Score: math.Round(score*1000) / 1000})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].Path < hits[j].Path
	})
	if limit > 0 && len(hits) > limit {
		hits = hits[:limit]
	}

	return hits
}
