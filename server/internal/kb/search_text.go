package kb

import (
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// SearchText builds kb_page.search_text: the title followed by the plain text
// of every block, one line per block. Markdown markers, link destinations and
// HTML are dropped; link text and code are kept.
func SearchText(title string, blocks []Block) string {
	lines := make([]string, 0, len(blocks)+1)
	if t := strings.TrimSpace(title); t != "" {
		lines = append(lines, t)
	}

	for _, block := range blocks {
		if plain := PlainText(block.Content); plain != "" {
			lines = append(lines, plain)
		}
	}

	return strings.Join(lines, "\n")
}

// PlainText returns the readable text of a Markdown fragment on one line.
func PlainText(markdown string) string {
	source := []byte(markdown)
	doc := markdownParser.Parse(text.NewReader(source))

	var b strings.Builder
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		switch node := n.(type) {
		case *ast.Text:
			b.Write(node.Segment.Value(source))
			if node.SoftLineBreak() || node.HardLineBreak() {
				b.WriteByte(' ')
			}
		case *ast.String:
			b.Write(node.Value)
		case *ast.AutoLink:
			b.Write(node.Label(source))
		case *ast.CodeBlock, *ast.FencedCodeBlock:
			lines := n.Lines()
			for i := range lines.Len() {
				segment := lines.At(i)
				b.Write(segment.Value(source))
				b.WriteByte(' ')
			}
		case *ast.RawHTML, *ast.HTMLBlock:
			return ast.WalkSkipChildren, nil
		}

		if n.Type() == ast.TypeBlock && n.PreviousSibling() != nil {
			b.WriteByte(' ')
		}

		return ast.WalkContinue, nil
	})

	return strings.Join(strings.Fields(b.String()), " ")
}
