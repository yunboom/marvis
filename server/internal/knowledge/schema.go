package knowledge

import (
	"bytes"
	"embed"
	"fmt"
	"sort"
	"strings"
	"text/template"

	"github.com/pkg/errors"
)

//go:embed schema/AGENTS.md.tmpl
var schemaFS embed.FS

var agentsTemplate = template.Must(template.ParseFS(schemaFS, "schema/AGENTS.md.tmpl"))

// PageGroups 是内置 schema 的页面分类目录，顺序即页面树的展示顺序。
var PageGroups = []string{"entities", "concepts", "howtos", "decisions", "syntheses", "sources", "queries"}

// Domains 是页面的领域标签。
var Domains = []string{"dev", "qa", "product"}

// SchemaInput 是生成一个知识库内置文件所需的信息。
type SchemaInput struct {
	Name    string
	Slug    string
	Purpose string
}

// BuiltinFiles 返回新知识库目录下的内置文件。
func BuiltinFiles(in SchemaInput) ([]FileChange, error) {
	var agents bytes.Buffer
	if err := agentsTemplate.Execute(&agents, in); err != nil {
		return nil, errors.Wrapf(err, "render AGENTS.md slug=%s", in.Slug)
	}

	purpose := strings.TrimSpace(in.Purpose)
	if purpose == "" {
		purpose = in.Name
	}
	files := []FileChange{
		{Path: in.Slug + "/AGENTS.md", Content: agents.Bytes()},
		{Path: in.Slug + "/purpose.md", Content: []byte("# " + in.Name + "\n\n" + purpose + "\n")},
		{Path: in.Slug + "/index.md", Content: []byte("---\nokf_version: \"0.2\"\n---\n\n# " + in.Name + "\n\n")},
		{Path: in.Slug + "/log.md", Content: []byte("# Log\n\n")},
		{Path: in.Slug + "/overview.md", Content: []byte("---\ntype: synthesis\ntitle: Overview\ndomains: [dev, qa, product]\n---\n\n# Overview\n")},
		{Path: in.Slug + "/raw/sources/.gitkeep"},
		{Path: in.Slug + "/raw/assets/.gitkeep"},
		{Path: in.Slug + "/.claims/.gitkeep"},
	}
	for _, g := range PageGroups {
		files = append(files, FileChange{Path: in.Slug + "/wiki/" + g + "/.gitkeep"})
	}

	return files, nil
}

// KnowledgeBaseEntry 是仓库根 README 里的一行。
type KnowledgeBaseEntry struct {
	Name        string
	Slug        string
	Description string
}

// ReadmeFile 生成仓库根目录 README.md，列出所有知识库。
func ReadmeFile(entries []KnowledgeBaseEntry) FileChange {
	sorted := append([]KnowledgeBaseEntry(nil), entries...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Slug < sorted[j].Slug })

	var b strings.Builder
	b.WriteString("# Knowledge bases\n\nEach directory is one knowledge base. Its `AGENTS.md` is the maintenance schema.\n\n")
	b.WriteString("| Directory | Name | Description |\n| --- | --- | --- |\n")
	for _, e := range sorted {
		fmt.Fprintf(&b, "| `%s/` | %s | %s |\n", e.Slug, cellText(e.Name), cellText(e.Description))
	}

	return FileChange{Path: "README.md", Content: []byte(b.String())}
}

func cellText(s string) string {
	return strings.NewReplacer("|", "\\|", "\n", " ").Replace(s)
}
