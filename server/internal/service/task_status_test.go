package service

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

const taskStatusSetMarker = "-- task status set: service."

var sqlQuotedValue = regexp.MustCompile(`'([a-z_]+)'`)

// taskStatusSets maps the set names SQL marker comments may reference.
var taskStatusSets = map[string][]string{
	"TerminalTaskStatuses":  TerminalTaskStatuses,
	"UnsettledTaskStatuses": UnsettledTaskStatuses,
}

func TestTaskStatusSetsCoverConstraint(t *testing.T) {
	schema, err := os.ReadFile(filepath.Join("..", "..", "schema.sql"))
	if err != nil {
		t.Fatalf("read schema.sql: %v", err)
	}

	var constraint string
	for line := range strings.SplitSeq(string(schema), "\n") {
		if strings.Contains(line, "agent_task_queue_status_check") {
			constraint = line
		}
	}
	if constraint == "" {
		t.Fatal("agent_task_queue_status_check not found in schema.sql")
	}

	want := quotedValues(constraint)
	got := slices.Concat(TerminalTaskStatuses, UnsettledTaskStatuses)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("terminal + unsettled statuses = %v, constraint allows %v", got, want)
	}

	for _, status := range TerminalTaskStatuses {
		if slices.Contains(UnsettledTaskStatuses, status) {
			t.Errorf("status %q is both terminal and unsettled", status)
		}
		if !IsTerminalTaskStatus(status) {
			t.Errorf("IsTerminalTaskStatus(%q) = false", status)
		}
	}
	for _, status := range UnsettledTaskStatuses {
		if IsTerminalTaskStatus(status) {
			t.Errorf("IsTerminalTaskStatus(%q) = true", status)
		}
	}
}

// TestTaskStatusSQLListsMatchGo checks every inline status list marked with
// taskStatusSetMarker against the Go set it names.
func TestTaskStatusSQLListsMatchGo(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "..", "pkg", "db", "queries", "*.sql"))
	if err != nil {
		t.Fatalf("glob queries: %v", err)
	}

	checked := 0
	for _, file := range files {
		content, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}

		lines := strings.Split(string(content), "\n")
		for i, line := range lines {
			_, name, ok := strings.Cut(line, taskStatusSetMarker)
			if !ok {
				continue
			}
			set, known := taskStatusSets[strings.TrimSpace(name)]
			if !known {
				t.Errorf("%s:%d: unknown task status set %q", file, i+1, name)
				continue
			}
			if i+1 >= len(lines) {
				t.Errorf("%s:%d: marker has no status list below it", file, i+1)
				continue
			}

			want := slices.Sorted(slices.Values(set))
			if got := quotedValues(lines[i+1]); !slices.Equal(got, want) {
				t.Errorf("%s:%d: SQL lists %v, %s is %v", file, i+2, got, name, want)
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no marked task status list found")
	}
}

func quotedValues(line string) []string {
	matches := sqlQuotedValue.FindAllStringSubmatch(line, -1)
	values := make([]string, 0, len(matches))
	for _, m := range matches {
		values = append(values, m[1])
	}
	slices.Sort(values)

	return values
}
