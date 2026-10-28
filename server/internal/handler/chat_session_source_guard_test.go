package handler

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// chatSurfaceQueryFiles hold the queries that list conversations.
var chatSurfaceQueryFiles = []string{"chat.sql", "kb.sql", "kb_sources.sql"}

// chatSurfaceQueries are the statements behind chat surfaces: the chat list
// and unread, the running indicator, Mika's conversation lookup, the
// workspace chat list and the ingestible chat sources. Each must filter by
// chat_session.source.
var chatSurfaceQueries = []string{
	"ListChatSessionsByCreator",
	"ListAllChatSessionsByCreator",
	"ListPendingChatTasksByCreator",
	"HasPendingChatTasksByCreator",
	"GetOldestActiveChatSessionForCreatorAgent",
	"ListKbWorkspaceChatSessions",
	"ListKbSources",
}

// creatorScopedSessionReadsWithoutSource are per-creator chat_session reads
// that are not chat surfaces, with the reason they need no source filter.
var creatorScopedSessionReadsWithoutSource = map[string]string{
	"ListAgentBuilderSessionsByCreator": "the agent builder's own list, keyed by its system carrier",
	"ListKbBuilderSessionsByCreator":    "the knowledge base builder's own list, keyed by kb_builder_session",
	"ListKbOwnChatSessionIDs":           "checks given ids for ownership, lists nothing",
}

var (
	sqlcQueryNamePattern   = regexp.MustCompile(`(?m)^-- name: (\w+) :\w+\s*$`)
	chatSessionReadPattern = regexp.MustCompile(`\b(FROM|JOIN)\s+chat_session\b`)
	sourceFilterPattern    = regexp.MustCompile(`\bsource\s*(=|<>|IN\b|=\s*ANY\b)`)
	rowLockPattern         = regexp.MustCompile(`\bFOR\s+(UPDATE|NO KEY UPDATE|KEY SHARE|SHARE)\b`)
	writeStatementPattern  = regexp.MustCompile(`(?i)^\s*(INSERT|UPDATE|DELETE)\b`)
)

// loadNamedQueries returns the SQL of every named query in the files, with
// comment lines removed.
func loadNamedQueries(t *testing.T, files []string) map[string]string {
	t.Helper()

	queries := make(map[string]string)
	for _, file := range files {
		raw, err := os.ReadFile(filepath.Join("..", "..", "pkg", "db", "queries", file))
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}

		text := string(raw)
		marks := sqlcQueryNamePattern.FindAllStringSubmatchIndex(text, -1)
		for i, mark := range marks {
			end := len(text)
			if i+1 < len(marks) {
				end = marks[i+1][0]
			}

			var body []string
			for _, line := range strings.Split(text[mark[1]:end], "\n") {
				if !strings.HasPrefix(strings.TrimSpace(line), "--") {
					body = append(body, line)
				}
			}
			queries[text[mark[2]:mark[3]]] = strings.Join(body, "\n")
		}
	}

	return queries
}

// TestChatSurfaceQueriesFilterBySource keeps job, run follow-up and builder
// conversations out of chat surfaces: the known surface queries filter by
// source, and any new per-creator chat_session read must either filter by
// source too or be listed with a reason.
func TestChatSurfaceQueriesFilterBySource(t *testing.T) {
	queries := loadNamedQueries(t, chatSurfaceQueryFiles)

	for _, name := range chatSurfaceQueries {
		sql, ok := queries[name]
		if !ok {
			t.Errorf("chat surface query %s not found", name)
			continue
		}
		if !sourceFilterPattern.MatchString(sql) {
			t.Errorf("chat surface query %s does not filter by chat_session.source", name)
		}
	}

	for name, sql := range queries {
		if !chatSessionReadPattern.MatchString(sql) || !strings.Contains(sql, "creator_id") {
			continue
		}
		if writeStatementPattern.MatchString(sql) || rowLockPattern.MatchString(sql) {
			continue
		}
		if _, ok := creatorScopedSessionReadsWithoutSource[name]; ok {
			continue
		}
		if !sourceFilterPattern.MatchString(sql) {
			t.Errorf("query %s reads chat_session per creator without a source filter; filter by source or list it in creatorScopedSessionReadsWithoutSource", name)
		}
	}
}
