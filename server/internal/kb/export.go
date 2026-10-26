package kb

import (
	"encoding/json"
	"io"
	"sort"
	"strings"

	"github.com/pkg/errors"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"gopkg.in/yaml.v3"
)

// Layout of an exported OKF bundle (spec 7.12): <slug>/ holds PURPOSE.md,
// SCHEMA.md, raw/ and the wiki/ bundle with a generated index.md per
// directory and one claims file per page under wiki/.claims/.
const (
	exportWikiDir    = "wiki"
	exportRawDir     = "raw"
	exportClaimsDir  = ".claims"
	exportIndexFile  = "index.md"
	exportPurpose    = "PURPOSE.md"
	exportSchema     = "SCHEMA.md"
	exportOKFVersion = "0.2"
	// exportIDKey is added to every page header so a bundle can be imported
	// back onto the same pages.
	exportIDKey = "marvis_id"
)

// exportLeadingKeys are written first in an exported page header, in this
// order; the remaining keys follow alphabetically.
var exportLeadingKeys = []string{"type", "title", "description"}

// BundleWriter receives the files of an export one at a time. Create returns
// the writer of the next file; it is valid until the next Create.
type BundleWriter interface {
	Create(name string) (io.Writer, error)
}

// ExportNode is the part of a live page the export lays out before reading
// page bodies: its place in the tree and what index files list.
type ExportNode struct {
	ID          string
	ParentID    string
	Slug        string
	Position    string
	Title       string
	Description string
}

// ExportPage is one live page with its body, header and claims.
type ExportPage struct {
	ID          string
	Frontmatter map[string]any
	Blocks      []Block
	Claims      []Claim
}

// ExportMeta is the knowledge base an export is made of.
type ExportMeta struct {
	Slug        string
	Name        string
	Description string
	Purpose     string
	Schema      string
}

// Export lays out a knowledge base as an OKF bundle. It holds the page tree
// and the blocks other pages link to, never every body: page bodies are
// written one at a time with WritePage, so a large knowledge base streams.
type Export struct {
	meta     ExportMeta
	tree     *PageTree
	nodes    map[string]ExportNode
	children map[string][]ExportNode
	// headings holds the heading text of linked heading blocks, by page and
	// block id; linked holds every linked block that is not a heading, which
	// gets a ^block anchor appended in the export.
	headings map[string]map[string]string
	linked   map[string]map[string]struct{}
}

// LinkedBlock is a block some page links to (kb_link.to_block_id).
type LinkedBlock struct {
	PageID  string
	BlockID string
	Content string
}

// NewExport prepares the layout of a bundle from the live page tree and the
// blocks links point at.
func NewExport(meta ExportMeta, nodes []ExportNode, linked []LinkedBlock) *Export {
	treeNodes := make([]TreeNode, len(nodes))
	export := &Export{
		meta:     meta,
		nodes:    make(map[string]ExportNode, len(nodes)),
		children: make(map[string][]ExportNode),
		headings: make(map[string]map[string]string),
		linked:   make(map[string]map[string]struct{}),
	}
	for i, node := range nodes {
		treeNodes[i] = TreeNode{ID: node.ID, ParentID: node.ParentID, Slug: node.Slug, Title: node.Title, Position: node.Position}
		export.nodes[node.ID] = node
	}
	export.tree = NewPageTree(treeNodes)

	for _, node := range nodes {
		if _, ok := export.tree.PathByPageID(node.ID); !ok {
			continue
		}
		export.children[node.ParentID] = append(export.children[node.ParentID], node)
	}
	for parent := range export.children {
		siblings := export.children[parent]
		sort.Slice(siblings, func(i, j int) bool {
			if siblings[i].Position != siblings[j].Position {
				return siblings[i].Position < siblings[j].Position
			}
			return siblings[i].ID < siblings[j].ID
		})
	}

	for _, block := range linked {
		if HeadingLevel(block.Content) > 0 {
			if export.headings[block.PageID] == nil {
				export.headings[block.PageID] = map[string]string{}
			}
			export.headings[block.PageID][block.BlockID] = strings.TrimSpace(PlainText(block.Content))
			continue
		}
		if export.linked[block.PageID] == nil {
			export.linked[block.PageID] = map[string]struct{}{}
		}
		export.linked[block.PageID][block.BlockID] = struct{}{}
	}

	return export
}

// Root is the top directory of the bundle, the knowledge base slug.
func (e *Export) Root() string {
	return e.meta.Slug
}

// RawPath is where a raw file lands in the bundle.
func (e *Export) RawPath(kind, name string) string {
	return e.meta.Slug + "/" + exportRawDir + "/" + RawDir(kind) + "/" + name
}

// pageFile is a page's file below wiki/: workflows/payment-callback.md.
func (e *Export) pageFile(pageID string) (string, bool) {
	path, ok := e.tree.PathByPageID(pageID)
	if !ok {
		return "", false
	}

	return strings.TrimPrefix(path, "/") + pageFileSuffix, true
}

// WriteFrame writes the files that do not come from page bodies: PURPOSE.md,
// SCHEMA.md and every generated index.md.
func (e *Export) WriteFrame(w BundleWriter) error {
	if err := writeBundleFile(w, e.meta.Slug+"/"+exportPurpose, ensureTrailingNewline(e.meta.Purpose)); err != nil {
		return err
	}
	if err := writeBundleFile(w, e.meta.Slug+"/"+exportSchema, ensureTrailingNewline(e.meta.Schema)); err != nil {
		return err
	}

	// One index per directory: the root and every page that has children.
	parents := make([]string, 0, len(e.children))
	for parent := range e.children {
		parents = append(parents, parent)
	}
	sort.Strings(parents)
	if _, ok := e.children[""]; !ok {
		parents = append([]string{""}, parents...)
	}

	for _, parent := range parents {
		dir := ""
		if parent != "" {
			file, ok := e.pageFile(parent)
			if !ok {
				continue
			}
			dir = strings.TrimSuffix(file, pageFileSuffix) + "/"
		}
		if e.hasIndexPage(parent) {
			continue
		}
		if err := writeBundleFile(w, e.wikiPath(dir+exportIndexFile), e.renderIndex(parent)); err != nil {
			return err
		}
	}

	return nil
}

// hasIndexPage reports whether a directory holds a page with the slug index,
// which takes the place of the generated index.
func (e *Export) hasIndexPage(parent string) bool {
	for _, child := range e.children[parent] {
		if child.Slug+pageFileSuffix == exportIndexFile {
			return true
		}
	}

	return false
}

func (e *Export) renderIndex(parent string) string {
	var b strings.Builder
	if parent == "" {
		b.WriteString("---\nokf_version: " + exportOKFVersion + "\n---\n\n# " + e.meta.Name + "\n")
		if e.meta.Description != "" {
			b.WriteString("\n" + e.meta.Description + "\n")
		}
	} else {
		node := e.nodes[parent]
		b.WriteString("# " + node.Title + "\n")
		if node.Description != "" {
			b.WriteString("\n" + node.Description + "\n")
		}
	}

	if children := e.children[parent]; len(children) > 0 {
		b.WriteString("\n")
		for _, child := range children {
			b.WriteString("- [" + escapeLinkText(child.Title) + "](" + escapeLinkPath(child.Slug+pageFileSuffix) + ")")
			if child.Description != "" {
				b.WriteString(": " + child.Description)
			}
			b.WriteString("\n")
		}
	}

	return b.String()
}

func (e *Export) wikiPath(name string) string {
	return e.meta.Slug + "/" + exportWikiDir + "/" + name
}

// WritePage writes one page's Markdown file and, when it has claims, its
// claims file. Pages without a path (a broken parent chain) are skipped.
func (e *Export) WritePage(w BundleWriter, page ExportPage) error {
	file, ok := e.pageFile(page.ID)
	if !ok {
		return nil
	}

	content, err := e.renderPage(file, page)
	if err != nil {
		return err
	}
	if err := writeBundleFile(w, e.wikiPath(file), content); err != nil {
		return err
	}
	if len(page.Claims) == 0 {
		return nil
	}

	claims, err := json.MarshalIndent(page.Claims, "", "  ")
	if err != nil {
		return errors.Wrapf(err, "encode claims page_id=%s", page.ID)
	}
	claimsFile := exportClaimsDir + "/" + strings.TrimSuffix(file, pageFileSuffix) + ".json"

	return writeBundleFile(w, e.wikiPath(claimsFile), string(claims)+"\n")
}

func (e *Export) renderPage(file string, page ExportPage) (string, error) {
	header, err := exportFrontmatter(page)
	if err != nil {
		return "", err
	}

	fromDir := ""
	if i := strings.LastIndex(file, "/"); i >= 0 {
		fromDir = file[:i]
	}
	anchors := e.linked[page.ID]
	blocks := make([]Block, len(page.Blocks))
	for i, block := range page.Blocks {
		blocks[i] = block
		blocks[i].Content = rewriteAllDestinations(block.Content, func(dest string) (string, bool) {
			return e.exportDestination(fromDir, dest)
		})
		if _, linked := anchors[block.ID]; linked {
			blocks[i].Content = appendBlockAnchor(blocks[i].Content, block.ID)
		}
	}

	return "---\n" + header + "---\n\n" + ensureTrailingNewline(JoinBlocks(blocks)), nil
}

// exportDestination rewrites one link or image destination of a page in
// fromDir (relative to wiki/): kb:// and path links become relative page
// paths, raw:// becomes a relative path into raw/. Others stay.
func (e *Export) exportDestination(fromDir, dest string) (string, bool) {
	if ref, ok := ParseRawURI(dest); ok {
		target := exportRawDir + "/" + RawDir(ref.Kind) + "/" + ref.Name
		rel := relativePath(fromDir, "../"+target)
		if _, fragment, found := strings.Cut(dest, "#"); found {
			rel += "#" + fragment
		}

		return escapeLinkPath(rel), true
	}

	target, ok := ParseLinkTarget(dest)
	if !ok {
		return "", false
	}

	var file, anchor string
	switch {
	case target.PageID != "":
		found := false
		file, found = e.pageFile(target.PageID)
		if !found {
			// A deleted page: there is no file to point at.
			return "", false
		}
		if target.BlockID != "" {
			if heading, isHeading := e.headings[target.PageID][target.BlockID]; isHeading {
				anchor = heading
			} else {
				anchor = blockAnchorPrefix + target.BlockID
			}
		}
	default:
		// A page not yet written keeps a relative path to the missing file.
		file = strings.TrimPrefix(target.Path, "/") + pageFileSuffix
		if target.BlockID != "" {
			anchor = blockAnchorPrefix + target.BlockID
		}
	}

	rel := escapeLinkPath(relativePath(fromDir, file))
	if anchor != "" {
		rel += "#" + escapeLinkPath(anchor)
	}

	return rel, true
}

// relativePath is target (relative to the wiki root, may start with ../)
// as seen from the directory fromDir.
func relativePath(fromDir, target string) string {
	from := splitPath(fromDir)
	to := splitPath(target)

	// A target above the wiki root ("../raw/…") is reached by climbing out
	// of every directory of fromDir first.
	common := 0
	if !strings.HasPrefix(target, "../") {
		for common < len(from) && common < len(to)-1 && from[common] == to[common] {
			common++
		}
	}

	parts := make([]string, 0, len(from)-common+len(to)-common)
	for range from[common:] {
		parts = append(parts, "..")
	}
	parts = append(parts, to[common:]...)

	return strings.Join(parts, "/")
}

func splitPath(path string) []string {
	if path == "" {
		return nil
	}

	return strings.Split(path, "/")
}

// escapeLinkPath percent-encodes the characters that end or break a Markdown
// link destination, as Obsidian expects (spaces become %20). Other
// characters, CJK included, stay readable.
func escapeLinkPath(path string) string {
	var b strings.Builder
	for _, r := range path {
		switch r {
		case ' ':
			b.WriteString("%20")
		case '(':
			b.WriteString("%28")
		case ')':
			b.WriteString("%29")
		case '<':
			b.WriteString("%3C")
		case '>':
			b.WriteString("%3E")
		case '%':
			b.WriteString("%25")
		default:
			b.WriteRune(r)
		}
	}

	return b.String()
}

// escapeLinkText escapes brackets in link text of a generated index.
func escapeLinkText(text string) string {
	return strings.NewReplacer(`\`, `\\`, "[", `\[`, "]", `\]`).Replace(text)
}

// appendBlockAnchor marks a block as a link target the way Obsidian reads it:
// " ^id" at the end of a paragraph, or "^id" on its own line after a
// structured block (list, quote, table, code).
func appendBlockAnchor(content, blockID string) string {
	content = strings.TrimRight(content, "\n")
	anchor := blockAnchorPrefix + blockID
	if isParagraphBlock(content) {
		return content + " " + anchor
	}

	return content + "\n\n" + anchor
}

func isParagraphBlock(content string) bool {
	doc := markdownParser.Parse(text.NewReader([]byte(content)))
	_, ok := doc.FirstChild().(*ast.Paragraph)

	return ok && doc.ChildCount() == 1
}

// exportFrontmatter renders a page header as YAML with marvis_id added: the
// leading keys first, then the rest alphabetically.
func exportFrontmatter(page ExportPage) (string, error) {
	keys := make([]string, 0, len(page.Frontmatter))
	for key := range page.Frontmatter {
		if key == exportIDKey {
			continue
		}
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		ri, rj := leadingKeyRank(keys[i]), leadingKeyRank(keys[j])
		if ri != rj {
			return ri < rj
		}
		return keys[i] < keys[j]
	})

	mapping := &yaml.Node{Kind: yaml.MappingNode}
	add := func(key string, value any) error {
		valueNode := &yaml.Node{}
		if err := valueNode.Encode(value); err != nil {
			return errors.Wrapf(err, "encode page header key=%q page_id=%s", key, page.ID)
		}
		mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, valueNode)

		return nil
	}
	for _, key := range keys {
		if err := add(key, page.Frontmatter[key]); err != nil {
			return "", err
		}
	}
	if err := add(exportIDKey, page.ID); err != nil {
		return "", err
	}

	out, err := yaml.Marshal(mapping)
	if err != nil {
		return "", errors.Wrapf(err, "render page header page_id=%s", page.ID)
	}

	return string(out), nil
}

func leadingKeyRank(key string) int {
	for i, leading := range exportLeadingKeys {
		if key == leading {
			return i
		}
	}

	return len(exportLeadingKeys)
}

// rewriteAllDestinations is RewriteLinkDestinations for both links and
// images: an exported page must also point its images at raw/.
func rewriteAllDestinations(content string, rewrite func(dest string) (string, bool)) string {
	for _, dest := range linkAndImageDestinations(content) {
		replacement, ok := rewrite(dest)
		if !ok || replacement == dest {
			continue
		}

		content = strings.ReplaceAll(content, "](<"+dest+">", "]("+replacement)
		content = replaceBareDestination(content, dest, replacement)
	}

	return content
}

func linkAndImageDestinations(content string) []string {
	doc := markdownParser.Parse(text.NewReader([]byte(content)))

	seen := make(map[string]struct{})
	dests := make([]string, 0)
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		var dest string
		switch node := n.(type) {
		case *ast.Link:
			dest = string(node.Destination)
		case *ast.Image:
			dest = string(node.Destination)
		default:
			return ast.WalkContinue, nil
		}
		if _, dup := seen[dest]; !dup {
			seen[dest] = struct{}{}
			dests = append(dests, dest)
		}

		return ast.WalkContinue, nil
	})

	return dests
}

func writeBundleFile(w BundleWriter, name, content string) error {
	file, err := w.Create(name)
	if err != nil {
		return errors.Wrapf(err, "create export file=%q", name)
	}
	if _, err := io.WriteString(file, content); err != nil {
		return errors.Wrapf(err, "write export file=%q", name)
	}

	return nil
}

func ensureTrailingNewline(s string) string {
	if s == "" || strings.HasSuffix(s, "\n") {
		return s
	}

	return s + "\n"
}
