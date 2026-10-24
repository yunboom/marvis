package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/daemon"
	"github.com/yunboom/marvis/server/internal/daemon/execenv"
	"github.com/yunboom/marvis/server/internal/issuestatus"
	"github.com/yunboom/marvis/server/internal/issueworkflow"
)

// Agents learn the CLI from the runtime brief, the per-turn prompt, the
// project workflow brief and the built-in skills. Those are hand-written text,
// so a renamed command or a dropped flag leaves them pointing at something
// that no longer exists. This test pins every `marvis ...` command they quote
// to the real cobra tree.

const (
	promptIssueID   = "11111111-1111-4111-8111-111111111111"
	promptCommentID = "22222222-2222-4222-8222-222222222222"
	promptAgentID   = "33333333-3333-4333-8333-333333333333"
	promptRunID     = "44444444-4444-4444-8444-444444444444"
	promptWakeupID  = "55555555-5555-4555-8555-555555555555"
	promptChatID    = "66666666-6666-4666-8666-666666666666"
	promptProjectID = "77777777-7777-4777-8777-777777777777"

	builtinSkillsDir       = "../../internal/service/builtin_skills"
	legacyBuiltinSkillsDir = "../../internal/service/builtin_skills_legacy"
)

var (
	// codeSpanRe matches fenced blocks first, then inline code spans.
	codeSpanRe = regexp.MustCompile("(?s)```[^\n]*\n(.*?)```|`([^`\n]+)`")
	// commandSplitRe separates shell commands chained inside one snippet.
	commandSplitRe = regexp.MustCompile(`&&|\|\||[|;\n]|\$\(`)
	// commandWordRe is a subcommand-shaped token.
	commandWordRe = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
)

// promptSource is one rendered prompt or skill file.
type promptSource struct {
	name string
	text string
}

func TestPromptsQuoteOnlyExistingCLICommands(t *testing.T) {
	sources := renderedPromptSources(t)
	sources = append(sources, builtinSkillSources(t)...)

	checked := 0
	for _, src := range sources {
		for _, command := range quotedMarvisCommands(src.text) {
			checked++
			if problem := checkCLICommand(rootCmd, command); problem != "" {
				t.Errorf("%s quotes `%s`: %s", src.name, command, problem)
			}
		}
	}

	t.Logf("checked %d quoted commands across %d sources", checked, len(sources))

	// Guards the extractor itself: if it silently stopped matching, every
	// source would pass with nothing checked.
	if checked < 50 {
		t.Fatalf("checked only %d quoted commands; the extractor no longer finds them", checked)
	}
}

func TestCheckCLICommandRejectsUnknownCommandsAndFlags(t *testing.T) {
	cases := []struct {
		command string
		ok      bool
	}{
		{"marvis issue get <id> --output json", true},
		{"marvis issue status XXX-12 done", true},
		{"marvis issue comment list <id> [--roots-only] [--summary]", true},
		{"marvis issue assign <id> (--to X | --to-id <uuid> | --unassign)", true},
		{"marvis issue wakeup <create|list|get>", true},
		{"marvis issue get <id> --help", true},
		{"marvis issue frobnicate <id>", false},
		{"marvis frobnicate", false},
		{"marvis issue get <id> --no-such-flag", false},
	}
	for _, tc := range cases {
		problem := checkCLICommand(rootCmd, tc.command)
		if (problem == "") != tc.ok {
			t.Errorf("checkCLICommand(%q) = %q, want ok=%v", tc.command, problem, tc.ok)
		}
	}
}

// renderedPromptSources renders the runtime brief for every task kind, the
// per-turn prompt for every trigger, and the project workflow brief.
func renderedPromptSources(t *testing.T) []promptSource {
	t.Helper()

	issueCtx := execenv.TaskContextForEnv{
		IssueID:          promptIssueID,
		TriggerCommentID: promptCommentID,
		AgentID:          promptAgentID,
		AgentName:        "Dev",
		AgentSkills:      []execenv.SkillContextForEnv{{Name: "marvis-platform", Description: "platform", Content: "platform"}},
		Repos:            []execenv.RepoContextForEnv{{URL: "https://github.com/example/repo"}},
		ProjectID:        promptProjectID,
		ProjectTitle:     "Project",
	}
	briefs := map[string]execenv.TaskContextForEnv{
		"issue":        issueCtx,
		"chat":         {AgentID: promptAgentID, AgentName: "Dev", ChatSessionID: promptChatID},
		"quick-create": {AgentID: promptAgentID, AgentName: "Dev", QuickCreatePrompt: "file a bug"},
		"autopilot":    {AgentID: promptAgentID, AgentName: "Dev", AutopilotRunID: promptRunID},
	}

	var sources []promptSource
	for kind, ctx := range briefs {
		brief, err := execenv.InjectRuntimeConfig(t.TempDir(), "claude", ctx)
		if err != nil {
			t.Fatalf("render %s runtime brief: %v", kind, err)
		}
		sources = append(sources, promptSource{name: "runtime brief (" + kind + ")", text: brief})
	}

	tasks := map[string]daemon.Task{
		"assignment":  {IssueID: promptIssueID, HandoffNote: "do it"},
		"comment":     {IssueID: promptIssueID, TriggerCommentID: promptCommentID},
		"wakeup":      {IssueID: promptIssueID, WakeupID: promptWakeupID, TriggerCommentID: promptCommentID},
		"chat":        {ChatSessionID: promptChatID},
		"autopilot":   {AutopilotRunID: promptRunID},
		"quickcreate": {QuickCreatePrompt: "file a bug"},
	}
	for trigger, task := range tasks {
		sources = append(sources, promptSource{name: "per-turn prompt (" + trigger + ")", text: daemon.BuildPrompt(task, "claude")})
	}

	return append(sources, workflowBriefSources()...)
}

// workflowBriefSources renders the project workflow brief with and without a
// blocked status, for the assignee and for an observer.
func workflowBriefSources() []promptSource {
	agent := issueworkflow.Handler{Type: issueworkflow.HandlerAgent, ID: promptAgentID}
	steps := []issueworkflow.Step{
		{StatusKey: issuestatus.Todo},
		{StatusKey: "dev", Handler: agent},
		{StatusKey: "qa", Handler: agent, Instructions: "test it", NextStatusKey: issuestatus.Done, BackStatusKey: "dev"},
		{StatusKey: issuestatus.Done},
		{StatusKey: issuestatus.Cancelled},
	}
	withBlocked := append(append([]issueworkflow.Step{}, steps[:3]...), issueworkflow.Step{StatusKey: issuestatus.Blocked})
	withBlocked = append(withBlocked, steps[3:]...)

	var sources []promptSource
	for name, wf := range map[string][]issueworkflow.Step{"no blocked": steps, "blocked": withBlocked} {
		for _, observer := range []bool{false, true} {
			brief := issueworkflow.Brief(issueworkflow.BriefInput{
				Workflow:        issueworkflow.Definition{Name: "Delivery", Steps: wf},
				StatusKey:       "qa",
				IssueIdentifier: "XXX-12",
				Observer:        observer,
			})
			label := "workflow brief (" + name + ")"
			if observer {
				label = "workflow brief (" + name + ", observer)"
			}
			sources = append(sources, promptSource{name: label, text: brief})
		}
	}

	return sources
}

// builtinSkillSources reads every Markdown file the built-in skills ship.
func builtinSkillSources(t *testing.T) []promptSource {
	t.Helper()

	var sources []promptSource
	for _, root := range []string{builtinSkillsDir, legacyBuiltinSkillsDir} {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || filepath.Ext(path) != ".md" {
				return err
			}
			text, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel("../../internal/service", path)
			sources = append(sources, promptSource{name: rel, text: string(text)})
			return nil
		})
		if err != nil {
			t.Fatalf("read built-in skills under %s: %v", root, err)
		}
	}
	if len(sources) == 0 {
		t.Fatal("found no built-in skill files")
	}

	return sources
}

// quotedMarvisCommands returns every `marvis ...` command inside the text's
// code spans and fenced blocks, one per chained shell command.
func quotedMarvisCommands(text string) []string {
	var out []string
	for _, m := range codeSpanRe.FindAllStringSubmatch(text, -1) {
		code := m[1] + m[2]
		code = strings.ReplaceAll(code, "\\\n", " ")
		for _, part := range commandSplitRe.Split(code, -1) {
			fields := strings.Fields(part)
			for i, f := range fields {
				// A command starts at the snippet's first word, or after an
				// env assignment or a shell prompt marker.
				if f != "marvis" {
					if strings.Contains(f, "=") || f == "$" || f == ">" {
						continue
					}
					break
				}
				if i+1 < len(fields) {
					out = append(out, strings.Join(fields[i:], " "))
				}
				break
			}
		}
	}

	return out
}

// checkCLICommand resolves a quoted command against the cobra tree and
// returns what does not exist, or "" when it does.
func checkCLICommand(root *cobra.Command, command string) string {
	tokens := strings.Fields(command)[1:]

	cmd := root
	i := 0
	for ; i < len(tokens); i++ {
		next := findSubcommand(cmd, tokens[i])
		if next == nil {
			break
		}
		cmd = next
	}

	// A bare word right after a command that only groups others is a
	// subcommand that does not exist.
	if i < len(tokens) && commandWordRe.MatchString(tokens[i]) && cmd.HasSubCommands() && !cmd.Runnable() {
		return "`" + cmd.CommandPath() + "` has no subcommand " + tokens[i]
	}

	for _, tok := range tokens[i:] {
		for _, alt := range strings.Split(tok, "|") {
			alt = strings.Trim(alt, "[]()\"',.")
			if !strings.HasPrefix(alt, "--") {
				continue
			}
			name := strings.TrimPrefix(alt, "--")
			name, _, _ = strings.Cut(name, "=")
			if name == "" || name == "help" {
				continue
			}
			if !hasFlag(cmd, name) {
				return "`" + cmd.CommandPath() + "` has no flag --" + name
			}
		}
	}

	return ""
}

func findSubcommand(cmd *cobra.Command, name string) *cobra.Command {
	for _, c := range cmd.Commands() {
		if c.Name() == name || c.HasAlias(name) {
			return c
		}
	}

	return nil
}

// hasFlag looks a flag up on the command and the persistent flags of every
// ancestor.
func hasFlag(cmd *cobra.Command, name string) bool {
	if cmd.Flags().Lookup(name) != nil {
		return true
	}
	for c := cmd; c != nil; c = c.Parent() {
		if c.PersistentFlags().Lookup(name) != nil {
			return true
		}
	}

	return false
}
