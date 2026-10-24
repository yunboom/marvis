package knowledge

import (
	"context"
	"strconv"
	"strings"

	"github.com/pkg/errors"
)

// DiffLineKind 是 diff 中一行的类型。
type DiffLineKind string

// DiffLine 的三种类型。
const (
	DiffContext DiffLineKind = "context"
	DiffAdd     DiffLineKind = "add"
	DiffDelete  DiffLineKind = "delete"
)

// DiffLine 是 diff 中的一行；OldLine / NewLine 为 0 表示该侧没有这一行。
type DiffLine struct {
	Kind    DiffLineKind `json:"kind"`
	Text    string       `json:"text"`
	OldLine int          `json:"old_line"`
	NewLine int          `json:"new_line"`
}

// FileDiff 是单个文件的改动。
type FileDiff struct {
	Path    string     `json:"path"`
	OldPath string     `json:"old_path,omitempty"`
	Status  string     `json:"status"`
	Binary  bool       `json:"binary"`
	Added   int        `json:"added"`
	Deleted int        `json:"deleted"`
	Lines   []DiffLine `json:"lines"`
}

// FileDiff.Status 的取值。
const (
	FileAdded    = "added"
	FileModified = "modified"
	FileDeleted  = "deleted"
	FileRenamed  = "renamed"
)

// Diff 返回从 base 到 head 的逐文件改动。
func (s *Store) Diff(ctx context.Context, workspaceID, base, head string) ([]FileDiff, error) {
	out, err := s.run(ctx, workspaceID, nil, nil, "diff", "--no-color", "--no-ext-diff", "-U3", "-M", base, head)
	if err != nil {
		return nil, errors.WithStack(err)
	}

	return ParseUnifiedDiff(string(out)), nil
}

// ParseUnifiedDiff 解析 git diff 的输出。
func ParseUnifiedDiff(raw string) []FileDiff {
	var files []FileDiff
	var cur *FileDiff
	oldLine, newLine := 0, 0

	flush := func() {
		if cur != nil {
			files = append(files, *cur)
		}
	}

	for _, line := range strings.Split(raw, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			flush()
			cur = &FileDiff{Status: FileModified, Lines: []DiffLine{}}
			if a, b, ok := splitDiffGitHeader(line); ok {
				cur.OldPath, cur.Path = a, b
			}
		case cur == nil:
			continue
		case strings.HasPrefix(line, "new file mode"):
			cur.Status = FileAdded
		case strings.HasPrefix(line, "deleted file mode"):
			cur.Status = FileDeleted
		case strings.HasPrefix(line, "rename from "):
			cur.Status = FileRenamed
			cur.OldPath = strings.TrimPrefix(line, "rename from ")
		case strings.HasPrefix(line, "rename to "):
			cur.Path = strings.TrimPrefix(line, "rename to ")
		case strings.HasPrefix(line, "Binary files "):
			cur.Binary = true
		case strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ ") || strings.HasPrefix(line, "index ") || strings.HasPrefix(line, "similarity index"):
			continue
		case strings.HasPrefix(line, "@@"):
			oldLine, newLine = parseHunkHeader(line)
		case strings.HasPrefix(line, "+"):
			cur.Lines = append(cur.Lines, DiffLine{Kind: DiffAdd, Text: line[1:], NewLine: newLine})
			cur.Added++
			newLine++
		case strings.HasPrefix(line, "-"):
			cur.Lines = append(cur.Lines, DiffLine{Kind: DiffDelete, Text: line[1:], OldLine: oldLine})
			cur.Deleted++
			oldLine++
		case strings.HasPrefix(line, " "):
			cur.Lines = append(cur.Lines, DiffLine{Kind: DiffContext, Text: line[1:], OldLine: oldLine, NewLine: newLine})
			oldLine++
			newLine++
		}
	}
	flush()

	for i := range files {
		if files[i].OldPath == files[i].Path {
			files[i].OldPath = ""
		}
	}

	return files
}

func splitDiffGitHeader(line string) (string, string, bool) {
	rest := strings.TrimPrefix(line, "diff --git ")
	idx := strings.Index(rest, " b/")
	if !strings.HasPrefix(rest, "a/") || idx < 0 {
		return "", "", false
	}

	return rest[2:idx], rest[idx+3:], true
}

// parseHunkHeader 解析 "@@ -a,b +c,d @@" 得到两侧起始行号。
func parseHunkHeader(line string) (int, int) {
	parts := strings.Fields(line)
	if len(parts) < 3 {
		return 0, 0
	}

	return hunkStart(parts[1]), hunkStart(parts[2])
}

func hunkStart(part string) int {
	part = strings.TrimLeft(part, "-+")
	if i := strings.Index(part, ","); i >= 0 {
		part = part[:i]
	}
	n, err := strconv.Atoi(part)
	if err != nil {
		return 0
	}

	return n
}
