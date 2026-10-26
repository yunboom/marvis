package kb

import (
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/pkg/errors"
)

// Source kinds, derived from the scheme of an evidence uri.
const (
	// SourceKindTask is an issue: task://MAR-142.
	SourceKindTask = "task"
	// SourceKindChat is a chat session: chat://<session id>.
	SourceKindChat = "chat"
	// SourceKindPR is a pull request: pr://<repo>/<number>.
	SourceKindPR = "pr"
	// SourceKindRepo is code: repo://<path>#L40-L82.
	SourceKindRepo = "repo"
	// SourceKindRaw is an uploaded raw file: raw://sources/<file>[#page=12].
	SourceKindRaw = "raw"
	// SourceKindWeb is a web page: https://….
	SourceKindWeb = "web"
	// SourceKindOther is a scheme this server does not know.
	SourceKindOther = "other"
)

// Raw file kinds (kb_raw.kind), the first path segment of a raw:// uri.
const (
	// RawKindSource is an uploaded source document.
	RawKindSource = "source"
	// RawKindAsset is an image or attachment pages link to.
	RawKindAsset = "asset"
)

// rawDirs maps the raw:// directory to the kb_raw kind it holds.
var rawDirs = map[string]string{
	"sources": RawKindSource,
	"assets":  RawKindAsset,
}

const pdfPageFragment = "page="

// Evidence is one piece of evidence behind a claim.
type Evidence struct {
	// Source is the footnote id the claim's sentence ends with.
	Source  string `json:"source"`
	URI     string `json:"uri"`
	Title   string `json:"title"`
	Version string `json:"version"`
}

// Claim is one factual sentence of a page and the evidence it was checked
// against, as stored in revisions and drafts.
type Claim struct {
	Key       string     `json:"key"`
	BlockID   string     `json:"block_id"`
	Text      string     `json:"text"`
	Evidence  []Evidence `json:"evidence"`
	CheckedAt string     `json:"checked_at"`
}

// Source is one entry of a page's source list, generated from its claims.
type Source struct {
	ID      string
	Kind    string
	URI     string
	Title   string
	Version string
}

// ParseClaims decodes a stored claims snapshot; an empty value has none.
func ParseClaims(raw []byte) ([]Claim, error) {
	if len(raw) == 0 {
		return []Claim{}, nil
	}

	var claims []Claim
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil, errors.Wrap(err, "decode claims")
	}
	if claims == nil {
		claims = []Claim{}
	}

	return claims, nil
}

// ParseBlocks decodes a stored blocks array; an empty value has none.
func ParseBlocks(raw []byte) ([]Block, error) {
	if len(raw) == 0 {
		return []Block{}, nil
	}

	var blocks []Block
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, errors.Wrap(err, "decode blocks")
	}
	if blocks == nil {
		blocks = []Block{}
	}

	return blocks, nil
}

// SourcesFromClaims lists the distinct sources the claims cite, in the order
// their claims appear on the page (block order, then claim order). The first
// evidence with a given footnote id wins.
func SourcesFromClaims(blocks []Block, claims []Claim) []Source {
	blockOrder := make(map[string]int, len(blocks))
	for i, block := range blocks {
		blockOrder[block.ID] = i
	}

	ordered := make([]Claim, len(claims))
	copy(ordered, claims)
	orderOf := func(c Claim) int {
		if i, ok := blockOrder[c.BlockID]; ok {
			return i
		}

		return len(blocks)
	}
	sort.SliceStable(ordered, func(i, j int) bool { return orderOf(ordered[i]) < orderOf(ordered[j]) })

	seen := make(map[string]struct{})
	sources := make([]Source, 0)
	for _, claim := range ordered {
		for _, ev := range claim.Evidence {
			if ev.Source == "" {
				continue
			}
			if _, dup := seen[ev.Source]; dup {
				continue
			}
			seen[ev.Source] = struct{}{}
			sources = append(sources, Source{
				ID:      ev.Source,
				Kind:    SourceKind(ev.URI),
				URI:     ev.URI,
				Title:   ev.Title,
				Version: ev.Version,
			})
		}
	}

	return sources
}

// SourceKind classifies an evidence uri by its scheme.
func SourceKind(uri string) string {
	scheme, _, found := strings.Cut(uri, "://")
	if !found {
		return SourceKindOther
	}

	switch strings.ToLower(scheme) {
	case SourceKindTask, SourceKindChat, SourceKindPR, SourceKindRepo, SourceKindRaw:
		return strings.ToLower(scheme)
	case "http", "https":
		return SourceKindWeb
	default:
		return SourceKindOther
	}
}

// RawRef is the file a raw:// uri points at.
type RawRef struct {
	// Kind is the kb_raw kind: source or asset.
	Kind string
	Name string
	// Page is the PDF page from #page=N, or 0.
	Page int
}

// ParseRawURI parses raw://sources/<file>[#page=N] and raw://assets/<file>.
func ParseRawURI(uri string) (RawRef, bool) {
	rest, found := strings.CutPrefix(uri, SourceKindRaw+"://")
	if !found {
		return RawRef{}, false
	}

	rest, fragment, _ := strings.Cut(rest, "#")
	dir, name, found := strings.Cut(rest, "/")
	if !found || name == "" {
		return RawRef{}, false
	}
	kind, ok := rawDirs[dir]
	if !ok {
		return RawRef{}, false
	}
	if unescaped, err := url.PathUnescape(name); err == nil {
		name = unescaped
	}

	ref := RawRef{Kind: kind, Name: name}
	if pageText, ok := strings.CutPrefix(fragment, pdfPageFragment); ok {
		if page, err := strconv.Atoi(pageText); err == nil && page > 0 {
			ref.Page = page
		}
	}

	return ref, true
}

// ParseTaskURI returns the issue number of task://<PREFIX>-<number>.
func ParseTaskURI(uri string) (int32, bool) {
	identifier, found := strings.CutPrefix(uri, SourceKindTask+"://")
	if !found {
		return 0, false
	}

	i := strings.LastIndex(identifier, "-")
	if i < 0 {
		return 0, false
	}
	number, err := strconv.ParseInt(identifier[i+1:], 10, 32)
	if err != nil || number <= 0 {
		return 0, false
	}

	return int32(number), true
}

// ParseChatURI returns the session id of chat://<session id>.
func ParseChatURI(uri string) (string, bool) {
	id, found := strings.CutPrefix(uri, SourceKindChat+"://")
	if !found || id == "" {
		return "", false
	}

	return id, true
}
