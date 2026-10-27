package execenv

import (
	"strings"
)

// The Knowledge Bases section of the brief, verbatim from spec 8.2. Prompt
// wording is reviewed with the other prompts (ticket 11); keep these in step
// with the spec rather than editing them here.
const (
	knowledgeBasesHeading = "## Knowledge Bases\n\n"
	knowledgeBasesIntro   = "These knowledge bases are the team's shared memory: reviewed facts, decisions and lessons from earlier work.\n\n"
	knowledgeBasesTable   = "| Slug | Name | Description |\n| --- | --- | --- |\n"
	// knowledgeBasesTruncated follows the table when the server cut the list.
	knowledgeBasesTruncated = "\nMore knowledge bases exist than are listed — run `marvis kb list` for the rest.\n"
	knowledgeBasesUsage     = "\n### Getting information\n\n" +
		"Judge from the descriptions above which knowledge base, if any, helps with the current work, and load only what you need:\n\n" +
		"- `marvis kb get <slug>` — read the `schema` field it returns: how pages are laid out and what each page type and field means.\n" +
		"- `marvis kb search \"<query>\" [--kb <slug>]` — find pages by keyword.\n" +
		"- `marvis kb page list <slug> [--parent <slug>:<path>]` — the table of contents. Without `--parent` it lists the top-level pages; with it, the child pages of the given page. Each comes with a one-line description.\n" +
		"- `marvis kb page fetch <slug>:<path>` — read a page.\n\n" +
		"More operations are in the `marvis-platform` skill, under `references/knowledge-bases.md`:\n\n" +
		"- Ingest: write new knowledge, lessons and key decisions from your work back into the knowledge base.\n" +
		"- Health check: find outdated, contradictory or missing content and record it.\n\n"
)

// writeKnowledgeBases emits the Knowledge Bases section (spec 8.2): the
// workspace's knowledge bases as a slug / name / description table, and the
// read commands. Nothing is written when the workspace has none or the
// server predates the field.
func writeKnowledgeBases(b *strings.Builder, ctx TaskContextForEnv) {
	rows := make([]string, 0, len(ctx.KnowledgeBases))
	for _, kb := range ctx.KnowledgeBases {
		// The slug goes inside backticks and is what every command takes; one
		// that is not a plain token cannot be addressed safely, so it is left out.
		slug := sanitizeBriefCodeToken(kb.Slug)
		if slug == "" {
			continue
		}
		rows = append(rows, "| `"+slug+"` | "+knowledgeBaseCell(kb.Name)+" | "+knowledgeBaseCell(kb.Description)+" |\n")
	}
	if len(rows) == 0 {
		return
	}

	b.WriteString(knowledgeBasesHeading)
	b.WriteString(knowledgeBasesIntro)
	b.WriteString(knowledgeBasesTable)
	for _, row := range rows {
		b.WriteString(row)
	}
	if ctx.KnowledgeBasesTruncated {
		b.WriteString(knowledgeBasesTruncated)
	}
	b.WriteString(knowledgeBasesUsage)
}

// knowledgeBaseCell flattens user-entered text into one table cell: one line,
// Markdown markers escaped so it cannot open a heading, and pipes escaped so
// it cannot split the row.
func knowledgeBaseCell(s string) string {
	return strings.ReplaceAll(sanitizeNameForBriefMarkdown(s), "|", `\|`)
}
