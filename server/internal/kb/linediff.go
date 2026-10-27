package kb

import "strings"

// Line diff operations.
const (
	// DiffEqual is a line both sides share.
	DiffEqual = "equal"
	// DiffAdded is a line only the new side has.
	DiffAdded = "added"
	// DiffDeleted is a line only the old side has.
	DiffDeleted = "deleted"
)

// maxDiffCells caps the LCS table; beyond it the changed middle is reported
// as a whole delete plus a whole add instead of a minimal diff.
const maxDiffCells = 4_000_000

// DiffLine is one line of a line diff. OldLine / NewLine are 1-based line
// numbers on each side, 0 where the line does not exist on that side.
type DiffLine struct {
	Op      string `json:"op"`
	OldLine int    `json:"old_line"`
	NewLine int    `json:"new_line"`
	Text    string `json:"text"`
}

// DiffStats counts added and deleted lines of a diff.
type DiffStats struct {
	Added   int
	Deleted int
}

// SplitLines splits Markdown into lines; an empty text has no lines.
func SplitLines(text string) []string {
	if text == "" {
		return nil
	}

	return strings.Split(text, "\n")
}

// LineDiff computes a minimal line diff from old to new: common prefix and
// suffix are matched directly, the middle by longest common subsequence.
func LineDiff(oldLines, newLines []string) []DiffLine {
	prefix := 0
	for prefix < len(oldLines) && prefix < len(newLines) && oldLines[prefix] == newLines[prefix] {
		prefix++
	}

	suffix := 0
	for suffix < len(oldLines)-prefix && suffix < len(newLines)-prefix &&
		oldLines[len(oldLines)-1-suffix] == newLines[len(newLines)-1-suffix] {
		suffix++
	}

	out := make([]DiffLine, 0, len(oldLines)+len(newLines))
	for i := 0; i < prefix; i++ {
		out = append(out, DiffLine{Op: DiffEqual, OldLine: i + 1, NewLine: i + 1, Text: oldLines[i]})
	}

	oldMid := oldLines[prefix : len(oldLines)-suffix]
	newMid := newLines[prefix : len(newLines)-suffix]
	out = append(out, diffMiddle(oldMid, newMid, prefix)...)

	for k := suffix; k > 0; k-- {
		oi := len(oldLines) - k
		ni := len(newLines) - k
		out = append(out, DiffLine{Op: DiffEqual, OldLine: oi + 1, NewLine: ni + 1, Text: oldLines[oi]})
	}

	return out
}

// diffMiddle diffs the part between the common prefix and suffix; offset is
// the prefix length, so line numbers continue from it.
func diffMiddle(oldLines, newLines []string, offset int) []DiffLine {
	n, m := len(oldLines), len(newLines)
	out := make([]DiffLine, 0, n+m)

	if n*m > maxDiffCells {
		for i, line := range oldLines {
			out = append(out, DiffLine{Op: DiffDeleted, OldLine: offset + i + 1, Text: line})
		}
		for j, line := range newLines {
			out = append(out, DiffLine{Op: DiffAdded, NewLine: offset + j + 1, Text: line})
		}

		return out
	}

	// lcs[i][j] is the LCS length of oldLines[i:] and newLines[j:].
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if oldLines[i] == newLines[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}

	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && oldLines[i] == newLines[j]:
			out = append(out, DiffLine{Op: DiffEqual, OldLine: offset + i + 1, NewLine: offset + j + 1, Text: oldLines[i]})
			i++
			j++
		case j < m && (i == n || lcs[i][j+1] > lcs[i+1][j]):
			out = append(out, DiffLine{Op: DiffAdded, NewLine: offset + j + 1, Text: newLines[j]})
			j++
		default:
			out = append(out, DiffLine{Op: DiffDeleted, OldLine: offset + i + 1, Text: oldLines[i]})
			i++
		}
	}

	return out
}

// Stats counts the added and deleted lines of a diff.
func Stats(lines []DiffLine) DiffStats {
	var s DiffStats
	for _, line := range lines {
		switch line.Op {
		case DiffAdded:
			s.Added++
		case DiffDeleted:
			s.Deleted++
		}
	}

	return s
}

// DiffHunk is a run of changes with the unchanged lines around it. Heading
// is the nearest Markdown heading above the hunk on the new side (old side
// for pure deletions), used as the hunk title.
type DiffHunk struct {
	Heading string     `json:"heading"`
	Lines   []DiffLine `json:"lines"`
}

// Hunks groups a diff into hunks with up to contextLines unchanged lines on
// each side; changes closer than twice that share a hunk.
func Hunks(lines []DiffLine, contextLines int) []DiffHunk {
	hunks := make([]DiffHunk, 0)

	start, end, firstChange := -1, -1, -1
	flush := func() {
		if start < 0 {
			return
		}
		hunks = append(hunks, DiffHunk{Heading: headingAbove(lines, firstChange), Lines: lines[start:end]})
		start, end, firstChange = -1, -1, -1
	}

	for i, line := range lines {
		if line.Op == DiffEqual {
			continue
		}

		from := max(i-contextLines, 0)
		to := min(i+contextLines+1, len(lines))
		if start >= 0 && from > end {
			flush()
		}
		if start < 0 {
			start = from
			firstChange = i
		}
		end = max(end, to)
	}
	flush()

	return hunks
}

// headingAbove returns the text of the closest heading line at or before
// index, without its # markers.
func headingAbove(lines []DiffLine, index int) string {
	for i := index; i >= 0; i-- {
		text := strings.TrimSpace(lines[i].Text)
		if !strings.HasPrefix(text, "#") {
			continue
		}

		heading := strings.TrimLeft(text, "#")
		if heading == "" || heading[0] != ' ' {
			continue
		}

		return strings.TrimSpace(heading)
	}

	return ""
}
