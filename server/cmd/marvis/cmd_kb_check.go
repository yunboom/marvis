package main

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
	"github.com/yunboom/marvis/server/internal/knowledge"
)

var kbLintCmd = &cobra.Command{
	Use:   "lint",
	Short: "Check a local knowledge repository clone for broken links, orphan pages, missing fields, broken citations and index drift",
	Args:  exactArgs(0),
	RunE:  runKBLint,
}

var kbStaleCmd = &cobra.Command{
	Use:   "stale",
	Short: "List claims whose code evidence changed since it was checked, and pages past stale_after",
	Long: "Compares the version recorded on each repo:// evidence with local code checkouts.\n" +
		"Pass every checkout with --repo <name>=<path> (or --repo <path>, named after its directory);\n" +
		"evidence in repositories that were not passed is reported as unchecked.",
	Args: exactArgs(0),
	RunE: runKBStale,
}

func init() {
	kbCmd.AddCommand(kbLintCmd, kbStaleCmd)
	for _, c := range []*cobra.Command{kbLintCmd, kbStaleCmd} {
		c.Flags().String("dir", ".", "Local clone of the knowledge repository")
		c.Flags().String("kb", "", "Only check this knowledge base (slug); all when empty")
		c.Flags().String("output", "table", "Output format: table or json")
	}
	kbStaleCmd.Flags().StringArray("repo", nil, "Code checkout as <name>=<path> or <path>; repeatable")
}

// loadLocalCorpus 读取本地克隆（不含 .git）并构建语料。
func loadLocalCorpus(dir string) (*knowledge.Corpus, error) {
	var files []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		files = append(files, filepath.ToSlash(rel))

		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read knowledge repository %s: %w", dir, err)
	}

	contents := map[string][]byte{}
	for _, f := range knowledge.CorpusContentPaths(files) {
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(f)))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", f, err)
		}
		contents[f] = b
	}

	return knowledge.NewCorpus("", files, contents), nil
}

func runKBLint(cmd *cobra.Command, _ []string) error {
	dir, _ := cmd.Flags().GetString("dir")
	slug, _ := cmd.Flags().GetString("kb")
	corpus, err := loadLocalCorpus(dir)
	if err != nil {
		return err
	}

	issues := corpus.Lint(slug)
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		if err := cli.PrintJSON(os.Stdout, map[string]any{"issues": nonNilSlice(issues)}); err != nil {
			return err
		}
	} else {
		printLintTable(issues)
	}

	// 有 error 级问题时以非零退出，提交前自查的脚本和智能体都能据此停下。
	errorCount := 0
	for _, is := range issues {
		if is.Severity == knowledge.SeverityError {
			errorCount++
		}
	}
	if errorCount > 0 {
		return fmt.Errorf("lint found %d error(s)", errorCount)
	}

	return nil
}

func printLintTable(issues []knowledge.LintIssue) {
	if len(issues) == 0 {
		fmt.Fprintln(os.Stdout, "No issues found.")
		return
	}
	rows := make([][]string, 0, len(issues))
	for _, is := range issues {
		rows = append(rows, []string{is.Severity, is.Code, is.Path, is.Message})
	}
	cli.PrintTable(os.Stdout, []string{"SEVERITY", "CODE", "PATH", "MESSAGE"}, rows)
}

func runKBStale(cmd *cobra.Command, _ []string) error {
	dir, _ := cmd.Flags().GetString("dir")
	slug, _ := cmd.Flags().GetString("kb")
	repoFlags, _ := cmd.Flags().GetStringArray("repo")
	repos, err := parseRepoFlags(repoFlags)
	if err != nil {
		return err
	}
	corpus, err := loadLocalCorpus(dir)
	if err != nil {
		return err
	}

	items, err := corpus.Stale(slug, time.Now(), repos)
	if err != nil {
		return err
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, map[string]any{"items": nonNilSlice(items)})
	}
	if len(items) == 0 {
		fmt.Fprintln(os.Stdout, "Nothing to re-check.")
		return nil
	}
	rows := make([][]string, 0, len(items))
	for _, it := range items {
		rows = append(rows, []string{it.Reason, it.Path, it.ClaimID, it.URI, it.Version})
	}
	cli.PrintTable(os.Stdout, []string{"REASON", "PAGE", "CLAIM", "EVIDENCE", "VERSION"}, rows)

	return nil
}

// parseRepoFlags 把 --repo 解析成仓库名到比对器的映射；只给路径时用目录名作仓库名。
func parseRepoFlags(flags []string) (map[string]knowledge.RepoDiffer, error) {
	repos := map[string]knowledge.RepoDiffer{}
	for _, f := range flags {
		name, p, ok := strings.Cut(f, "=")
		if !ok {
			p = f
			name = filepath.Base(filepath.Clean(f))
		}
		if name == "" || p == "" {
			return nil, fmt.Errorf("invalid --repo %q: expected <name>=<path> or <path>", f)
		}
		if _, dup := repos[name]; dup {
			return nil, fmt.Errorf("repository %q passed more than once", name)
		}
		repos[name] = gitDiffer{dir: p}
	}

	return repos, nil
}

// gitDiffer 用本地代码仓库实现 knowledge.RepoDiffer，与工作区（含未提交改动）比对。
type gitDiffer struct{ dir string }

func (g gitDiffer) ChangedSince(version string) (map[string]bool, bool, error) {
	if _, err := runGit(g.dir, "cat-file", "-e", version+"^{commit}"); err != nil {
		return nil, false, nil
	}

	out, err := runGit(g.dir, "diff", "--name-only", "--no-renames", version, "--")
	if err != nil {
		return nil, false, err
	}
	changed := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			changed[line] = true
		}
	}

	return changed, true, nil
}

func runGit(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s in %s: %w: %s", args[0], dir, err, strings.TrimSpace(stderr.String()))
	}

	return stdout.String(), nil
}

func nonNilSlice[T any](s []T) []T {
	if s == nil {
		return []T{}
	}

	return s
}
