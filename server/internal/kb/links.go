package kb

import (
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// pageLinkScheme prefixes stored page links: kb://<page id>#<block id>.
const pageLinkScheme = "kb://"

// pageFileSuffix is the extension agents write on page paths.
const pageFileSuffix = ".md"

// blockAnchorPrefix marks a block anchor in a written path: /a/b.md#^b9Lm.
const blockAnchorPrefix = "^"

// LinkTarget is where one page link points.
type LinkTarget struct {
	// PageID is set when the link is stored as kb://; empty for a path.
	PageID string
	// Path is the page path for a path link, without the .md suffix.
	Path string
	// BlockID is the block anchor, or empty for the page itself.
	BlockID string
}

// ParseLinkTarget recognizes a page link destination: the stored form
// kb://<page id>[#<block id>] or a knowledge base path /a/b.md[#^<block id>].
// Other destinations (web, raw://, relative paths) report ok=false.
func ParseLinkTarget(dest string) (LinkTarget, bool) {
	if rest, found := strings.CutPrefix(dest, pageLinkScheme); found {
		pageID, blockID, _ := strings.Cut(rest, "#")
		if _, err := uuid.Parse(pageID); err != nil {
			return LinkTarget{}, false
		}

		return LinkTarget{PageID: pageID, BlockID: blockID}, true
	}

	if !strings.HasPrefix(dest, "/") || strings.HasPrefix(dest, "//") {
		return LinkTarget{}, false
	}

	path, anchor, _ := strings.Cut(dest, "#")
	if unescaped, err := url.PathUnescape(path); err == nil {
		path = unescaped
	}
	path = NormalizePagePath(path)
	if path == "/" {
		return LinkTarget{}, false
	}

	return LinkTarget{Path: path, BlockID: strings.TrimPrefix(anchor, blockAnchorPrefix)}, true
}

// NormalizePagePath trims the .md suffix and trailing slashes from a page
// path and makes it absolute: "payment/callback.md/" -> "/payment/callback".
func NormalizePagePath(path string) string {
	path = strings.TrimSpace(path)
	path = strings.TrimSuffix(path, pageFileSuffix)
	path = strings.Trim(path, "/")

	return "/" + path
}

// FormatPageLink renders the stored form of a link to a page or block.
func FormatPageLink(pageID, blockID string) string {
	if blockID == "" {
		return pageLinkScheme + pageID
	}

	return pageLinkScheme + pageID + "#" + blockID
}

// FormatPathLink renders the form agents read and write: /a/b.md[#^block].
func FormatPathLink(path, blockID string) string {
	link := NormalizePagePath(path) + pageFileSuffix
	if blockID == "" {
		return link
	}

	return link + "#" + blockAnchorPrefix + blockID
}

// Link is one outgoing page link found in a block, the shape of a kb_link row.
type Link struct {
	FromBlockID string
	// ToPageID is empty when the target page does not exist yet.
	ToPageID  string
	ToBlockID string
	// ToPath is the target path at write time.
	ToPath string
}

// PageResolver maps between page paths and page ids within one knowledge base.
type PageResolver interface {
	// PageIDByPath returns the id of the live page at path.
	PageIDByPath(path string) (string, bool)
	// PathByPageID returns the current path of a live page.
	PathByPageID(pageID string) (string, bool)
}

// ResolveLinks prepares blocks for storage: links written as paths to
// existing pages become kb://<id>[#<block>], unresolved paths stay as written
// (a page not yet written). It returns the rewritten blocks and every page
// link they hold, which is what kb_link stores for the mainline.
func ResolveLinks(blocks []Block, resolver PageResolver) ([]Block, []Link) {
	out := make([]Block, len(blocks))
	links := make([]Link, 0)

	for i, block := range blocks {
		rewrites := make(map[string]string)

		for _, dest := range linkDestinations(block.Content) {
			target, ok := ParseLinkTarget(dest)
			if !ok {
				continue
			}

			link := Link{FromBlockID: block.ID, ToBlockID: target.BlockID}
			switch {
			case target.PageID != "":
				link.ToPageID = target.PageID
				if path, found := resolver.PathByPageID(target.PageID); found {
					link.ToPath = path
				}
			default:
				link.ToPath = target.Path
				if pageID, found := resolver.PageIDByPath(target.Path); found {
					link.ToPageID = pageID
					rewrites[dest] = FormatPageLink(pageID, target.BlockID)
				}
			}
			links = append(links, link)
		}

		out[i] = block
		out[i].Content = RewriteLinkDestinations(block.Content, func(dest string) (string, bool) {
			replacement, ok := rewrites[dest]
			return replacement, ok
		})
	}

	return out, links
}

// linkDestinations lists the destinations of inline links in a Markdown
// fragment, in document order and without duplicates.
func linkDestinations(content string) []string {
	source := []byte(content)
	doc := markdownParser.Parse(text.NewReader(source))

	seen := make(map[string]struct{})
	dests := make([]string, 0)
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		link, ok := n.(*ast.Link)
		if !ok {
			return ast.WalkContinue, nil
		}

		dest := string(link.Destination)
		if _, dup := seen[dest]; !dup {
			seen[dest] = struct{}{}
			dests = append(dests, dest)
		}

		return ast.WalkContinue, nil
	})

	return dests
}

// RewriteLinkDestinations rewrites inline link destinations in a Markdown
// fragment. rewrite returns the new destination and true to replace one.
// Both the plain "](dest" and angle-bracket "](<dest>" forms are handled; link
// text and titles are left untouched. Reading pages back for agents (kb:// to
// path) uses the same function with the reverse mapping.
func RewriteLinkDestinations(content string, rewrite func(dest string) (string, bool)) string {
	for _, dest := range linkDestinations(content) {
		replacement, ok := rewrite(dest)
		if !ok || replacement == dest {
			continue
		}

		content = strings.ReplaceAll(content, "](<"+dest+">", "](<"+replacement+">")
		content = replaceBareDestination(content, dest, replacement)
	}

	return content
}

// replaceBareDestination replaces "](dest" only where dest ends the
// destination, so /a.md is not rewritten inside /a.md#^b1.
func replaceBareDestination(content, dest, replacement string) string {
	needle := "](" + dest

	var b strings.Builder
	for {
		i := strings.Index(content, needle)
		if i < 0 {
			b.WriteString(content)
			break
		}

		end := i + len(needle)
		b.WriteString(content[:i])
		if end == len(content) || strings.ContainsRune(") \t\n", rune(content[end])) {
			b.WriteString("](" + replacement)
		} else {
			b.WriteString(needle)
		}
		content = content[end:]
	}

	return b.String()
}

// PathLinks rewrites stored kb:// links in blocks to the path form agents and
// diffs read: /a/b.md[#^block]. Links to pages without a path (deleted or
// unknown) stay as stored.
func PathLinks(blocks []Block, resolver PageResolver) []Block {
	out := make([]Block, len(blocks))
	for i, block := range blocks {
		out[i] = block
		out[i].Content = RewriteLinkDestinations(block.Content, func(dest string) (string, bool) {
			target, ok := ParseLinkTarget(dest)
			if !ok || target.PageID == "" {
				return "", false
			}
			path, found := resolver.PathByPageID(target.PageID)
			if !found {
				return "", false
			}

			return FormatPathLink(path, target.BlockID), true
		})
	}

	return out
}
