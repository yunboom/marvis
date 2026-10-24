package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
)

const (
	kbGitRepoPath    = "/api/knowledge/git/workspace.git"
	kbBranchPrefix   = "kb/"
	kbDefaultAuthor  = "Marvis Agent"
	kbDefaultEmail   = "agent@marvis.local"
	kbMainBranchName = "main"
)

var kbCloneCmd = &cobra.Command{
	Use:   "clone [dir]",
	Short: "Clone the workspace knowledge repository (all knowledge bases)",
	Long: `Clone the workspace knowledge repository into dir (default: ./knowledge).

Credentials are passed per command and never written into the clone. Use
"marvis kb sync" to update it and "marvis kb change create" to submit changes.`,
	Args: cobra.MaximumNArgs(1),
	RunE: runKBClone,
}

var kbSyncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Fetch the latest main and rebase the current branch onto it",
	RunE:  runKBSync,
}

var kbChangeCmd = &cobra.Command{
	Use:   "change",
	Short: "Submit and follow change requests",
}

var kbChangeCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Commit local edits to a kb/* branch, push it and open a change request",
	RunE:  runKBChangeCreate,
}

var kbChangeUpdateCmd = &cobra.Command{
	Use:   "update <number>",
	Short: "Commit and push the current kb/* branch again and refresh its change request",
	Args:  exactArgs(1),
	RunE:  runKBChangeUpdate,
}

var kbChangeGetCmd = &cobra.Command{
	Use:   "get <number>",
	Short: "Show a change request, its diff and review comments",
	Args:  exactArgs(1),
	RunE:  runKBChangeGet,
}

var kbChangeListCmd = &cobra.Command{
	Use:   "list",
	Short: "List change requests",
	RunE:  runKBChangeList,
}

var kbChangeMergeCmd = &cobra.Command{
	Use:   "merge <number>",
	Short: "Merge a change request (workspace owner or admin, with your own credentials)",
	Args:  exactArgs(1),
	RunE:  func(cmd *cobra.Command, args []string) error { return runKBChangeAction(cmd, args[0], "merge") },
}

var kbChangeCloseCmd = &cobra.Command{
	Use:   "close <number>",
	Short: "Close a change request; its annotations go back to pending",
	Args:  exactArgs(1),
	RunE:  func(cmd *cobra.Command, args []string) error { return runKBChangeAction(cmd, args[0], "close") },
}

var kbChangeRevertCmd = &cobra.Command{
	Use:   "revert <number>",
	Short: "Open a change request that undoes a merged one",
	Args:  exactArgs(1),
	RunE:  func(cmd *cobra.Command, args []string) error { return runKBChangeAction(cmd, args[0], "revert") },
}

var kbChangeCommentCmd = &cobra.Command{
	Use:   "comment <number>",
	Short: "Comment on a line of a change request",
	Args:  exactArgs(1),
	RunE:  runKBChangeComment,
}

var kbHistoryCmd = &cobra.Command{
	Use:   "history",
	Short: "List merged changes",
	RunE:  runKBHistory,
}

func init() {
	kbCmd.AddCommand(kbCloneCmd, kbSyncCmd, kbChangeCmd, kbHistoryCmd)
	kbChangeCmd.AddCommand(kbChangeCreateCmd, kbChangeUpdateCmd, kbChangeGetCmd, kbChangeListCmd,
		kbChangeMergeCmd, kbChangeCloseCmd, kbChangeRevertCmd, kbChangeCommentCmd)
	for _, c := range []*cobra.Command{kbChangeMergeCmd, kbChangeCloseCmd, kbChangeRevertCmd} {
		c.Flags().String("output", "table", "Output format: table or json")
	}
	kbChangeCommentCmd.Flags().String("path", "", "File path in the repository (required)")
	kbChangeCommentCmd.Flags().Int("line", 0, "Line number in the new file (required)")
	kbChangeCommentCmd.Flags().String("body", "", "Comment text (required)")
	kbHistoryCmd.Flags().Int("limit", 20, "Number of merged changes to list")
	kbHistoryCmd.Flags().String("output", "table", "Output format: table or json")

	kbSyncCmd.Flags().String("dir", ".", "Local clone of the knowledge repository")

	for _, c := range []*cobra.Command{kbChangeCreateCmd, kbChangeUpdateCmd} {
		c.Flags().String("dir", ".", "Local clone of the knowledge repository")
		c.Flags().String("title", "", "Change request title")
		c.Flags().String("summary", "", "Self-review: what changed and why")
		c.Flags().String("risk", "", "Risk: low, medium or high")
		c.Flags().StringSlice("annotations", nil, "Annotation IDs this change handles")
		c.Flags().String("output", "table", "Output format: table or json")
	}
	kbChangeCreateCmd.Flags().String("source", "", "What produced the change: fix, ingest, fresh, merge, gap or digest")
	kbChangeCreateCmd.Flags().String("session", "", "Knowledge session (chat session ID) that produced the change")

	kbChangeGetCmd.Flags().Bool("comments", false, "Print review comments")
	kbChangeGetCmd.Flags().Bool("diff", false, "Print the diff")
	kbChangeGetCmd.Flags().String("output", "table", "Output format: table or json")
	kbChangeListCmd.Flags().String("status", "open", "Filter: open, merged, closed or all")
	kbChangeListCmd.Flags().String("output", "table", "Output format: table or json")
}

// kbGit runs git in dir with the API credentials attached as HTTP headers.
func kbGit(client *cli.APIClient, dir string, args ...string) (string, error) {
	full := []string{"-c", "http.extraHeader=Authorization: Bearer " + client.Token}
	if client.WorkspaceID != "" {
		full = append(full, "-c", "http.extraHeader=X-Workspace-ID: "+client.WorkspaceID)
	}
	full = append(full, args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	text := strings.TrimSpace(out.String())
	if err != nil {
		return text, fmt.Errorf("git %s: %w: %s", args[0], err, text)
	}

	return text, nil
}

func kbRepoURL(client *cli.APIClient) string {
	return strings.TrimSuffix(client.BaseURL, "/") + kbGitRepoPath
}

func runKBClone(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	dir := "knowledge"
	if len(args) == 1 {
		dir = args[0]
	}
	if _, err := kbGit(client, ".", "clone", "-q", kbRepoURL(client), dir); err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "Cloned the knowledge repository into %s\n", dir)

	return err
}

func runKBSync(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	dir, _ := cmd.Flags().GetString("dir")
	if _, err := kbGit(client, dir, "fetch", "-q", "origin", kbMainBranchName); err != nil {
		return err
	}
	branch, err := kbGit(client, dir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return err
	}
	if branch == kbMainBranchName {
		_, err = kbGit(client, dir, "merge", "-q", "--ff-only", "origin/"+kbMainBranchName)
	} else {
		_, err = kbGit(client, dir, "rebase", "-q", "origin/"+kbMainBranchName)
		if err != nil {
			return fmt.Errorf("%w\nresolve the conflicts, then run git rebase --continue", err)
		}
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "%s is up to date with main\n", branch)

	return err
}

// commitAndPush commits everything in dir to a kb/* branch (creating one when
// the clone is on main) and pushes it. It returns the branch name.
func commitAndPush(client *cli.APIClient, dir, message string, force bool) (string, error) {
	if _, err := kbGit(client, dir, "rev-parse", "--is-inside-work-tree"); err != nil {
		return "", fmt.Errorf("%s is not a knowledge repository clone; run marvis kb clone first", dir)
	}
	branch, err := kbGit(client, dir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(branch, kbBranchPrefix) {
		suffix := make([]byte, 4)
		if _, err := rand.Read(suffix); err != nil {
			return "", fmt.Errorf("generate branch name: %w", err)
		}
		branch = kbBranchPrefix + hex.EncodeToString(suffix)
		if _, err := kbGit(client, dir, "checkout", "-q", "-b", branch); err != nil {
			return "", err
		}
	}
	if _, err := kbGit(client, dir, "add", "-A"); err != nil {
		return "", err
	}
	if _, err := kbGit(client, dir, "diff", "--cached", "--quiet"); err != nil {
		if message == "" {
			message = "Update knowledge"
		}
		if _, err := kbGit(client, dir, "-c", "user.name="+gitConfigOr(dir, "user.name", kbDefaultAuthor),
			"-c", "user.email="+gitConfigOr(dir, "user.email", kbDefaultEmail), "commit", "-q", "-m", message); err != nil {
			return "", err
		}
	}
	pushArgs := []string{"push", "-q", "origin", "HEAD:refs/heads/" + branch}
	if force {
		pushArgs = append(pushArgs, "--force")
	}
	if _, err := kbGit(client, dir, pushArgs...); err != nil {
		return "", err
	}

	return branch, nil
}

func gitConfigOr(dir, key, fallback string) string {
	cmd := exec.Command("git", "config", "--get", key)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		return fallback
	}

	return strings.TrimSpace(string(out))
}

func changeBodyFromFlags(cmd *cobra.Command) map[string]any {
	body := map[string]any{}
	for flag, field := range map[string]string{"title": "title", "summary": "summary", "risk": "risk"} {
		if cmd.Flags().Changed(flag) {
			v, _ := cmd.Flags().GetString(flag)
			body[field] = v
		}
	}
	if cmd.Flags().Changed("annotations") {
		ids, _ := cmd.Flags().GetStringSlice("annotations")
		body["annotation_ids"] = ids
	}

	return body
}

func printKBChange(cmd *cobra.Command, change map[string]any) error {
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, change)
	}
	fmt.Fprintf(os.Stdout, "#%s %s [%s] %s\n", strVal(change, "number"), strVal(change, "title"), strVal(change, "status"), strVal(change, "branch"))
	if conflict, _ := change["conflict"].(bool); conflict {
		fmt.Fprintln(os.Stdout, "Conflicts with main in:")
		if files, ok := change["conflict_files"].([]any); ok {
			for _, f := range files {
				fmt.Fprintf(os.Stdout, "  %v\n", f)
			}
		}
		fmt.Fprintf(os.Stdout, "Run marvis kb sync, resolve the conflicts, then marvis kb change update %s\n", strVal(change, "number"))
	}

	return nil
}

func runKBChangeCreate(cmd *cobra.Command, _ []string) error {
	title, _ := cmd.Flags().GetString("title")
	if strings.TrimSpace(title) == "" {
		return fmt.Errorf("--title is required")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	dir, _ := cmd.Flags().GetString("dir")
	branch, err := commitAndPush(client, dir, title, false)
	if err != nil {
		return err
	}

	body := changeBodyFromFlags(cmd)
	body["branch"] = branch
	if source, _ := cmd.Flags().GetString("source"); source != "" {
		body["source"] = source
	}
	if session, _ := cmd.Flags().GetString("session"); session != "" {
		body["chat_session_id"] = session
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var change map[string]any
	if err := client.PostJSON(ctx, "/api/knowledge/changes", body, &change); err != nil {
		return fmt.Errorf("open change request for %s: %w", branch, err)
	}

	return printKBChange(cmd, change)
}

func runKBChangeUpdate(cmd *cobra.Command, args []string) error {
	number, err := strconv.Atoi(strings.TrimPrefix(args[0], "#"))
	if err != nil {
		return fmt.Errorf("invalid change request number %q", args[0])
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	dir, _ := cmd.Flags().GetString("dir")
	title, _ := cmd.Flags().GetString("title")
	// A rebase onto main rewrites the branch, so the update push is forced; the
	// branch belongs to this change request alone.
	if _, err := commitAndPush(client, dir, title, true); err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var change map[string]any
	if err := client.PatchJSON(ctx, fmt.Sprintf("/api/knowledge/changes/%d", number), changeBodyFromFlags(cmd), &change); err != nil {
		return fmt.Errorf("update change request #%d: %w", number, err)
	}

	return printKBChange(cmd, change)
}

func runKBChangeGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var change map[string]any
	if err := client.GetJSON(ctx, "/api/knowledge/changes/"+strings.TrimPrefix(args[0], "#"), &change); err != nil {
		return fmt.Errorf("get change request %s: %w", args[0], err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, change)
	}

	if err := printKBChange(cmd, change); err != nil {
		return err
	}
	if s := strVal(change, "summary"); s != "" {
		fmt.Fprintf(os.Stdout, "Summary: %s\n", s)
	}
	if showDiff, _ := cmd.Flags().GetBool("diff"); showDiff {
		printKBDiff(change)
	}
	if showComments, _ := cmd.Flags().GetBool("comments"); showComments {
		comments, _ := change["comments"].([]any)
		if len(comments) == 0 {
			fmt.Fprintln(os.Stdout, "No review comments.")
		}
		for _, c := range comments {
			m, _ := c.(map[string]any)
			fmt.Fprintf(os.Stdout, "%s:%s %s\n", strVal(m, "path"), strVal(m, "line"), strVal(m, "body"))
		}
	}

	return nil
}

func printKBDiff(change map[string]any) {
	groups, _ := change["groups"].([]any)
	for _, g := range groups {
		gm, _ := g.(map[string]any)
		files, _ := gm["files"].([]any)
		for _, f := range files {
			fm, _ := f.(map[string]any)
			fmt.Fprintf(os.Stdout, "--- %s\n", strVal(fm, "path"))
			lines, _ := fm["lines"].([]any)
			for _, l := range lines {
				lm, _ := l.(map[string]any)
				sign := " "
				switch strVal(lm, "kind") {
				case "add":
					sign = "+"
				case "delete":
					sign = "-"
				}
				fmt.Fprintf(os.Stdout, "%s%s\n", sign, strVal(lm, "text"))
			}
		}
	}
}

func runKBChangeAction(cmd *cobra.Command, ref, action string) error {
	number := strings.TrimPrefix(ref, "#")
	if _, err := strconv.Atoi(number); err != nil {
		return fmt.Errorf("invalid change request number %q", ref)
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var change map[string]any
	if err := client.PostJSON(ctx, "/api/knowledge/changes/"+number+"/"+action, map[string]any{}, &change); err != nil {
		return fmt.Errorf("%s change request #%s: %w", action, number, err)
	}

	return printKBChange(cmd, change)
}

func runKBChangeComment(cmd *cobra.Command, args []string) error {
	path, _ := cmd.Flags().GetString("path")
	line, _ := cmd.Flags().GetInt("line")
	body, _ := cmd.Flags().GetString("body")
	if path == "" || line <= 0 || strings.TrimSpace(body) == "" {
		return fmt.Errorf("--path, --line and --body are required")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var comment map[string]any
	number := strings.TrimPrefix(args[0], "#")
	if err := client.PostJSON(ctx, "/api/knowledge/changes/"+number+"/comments", map[string]any{"path": path, "line": line, "body": body}, &comment); err != nil {
		return fmt.Errorf("comment on change request #%s: %w", number, err)
	}
	_, err = fmt.Fprintf(os.Stdout, "Commented on %s:%d\n", path, line)

	return err
}

func runKBHistory(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	limit, _ := cmd.Flags().GetInt("limit")
	var changes []map[string]any
	if err := client.GetJSON(ctx, fmt.Sprintf("/api/knowledge/history?limit=%d", limit), &changes); err != nil {
		return fmt.Errorf("list knowledge history: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, changes)
	}
	rows := make([][]string, 0, len(changes))
	for _, c := range changes {
		commit := strVal(c, "merge_commit")
		if len(commit) > 9 {
			commit = commit[:9]
		}
		rows = append(rows, []string{commit, "#" + strVal(c, "number"), strVal(c, "merged_at"), strVal(c, "author_name"), strVal(c, "title")})
	}
	cli.PrintTable(os.Stdout, []string{"COMMIT", "NUMBER", "MERGED_AT", "AUTHOR", "TITLE"}, rows)

	return nil
}

func runKBChangeList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	path := "/api/knowledge/changes"
	if status, _ := cmd.Flags().GetString("status"); status != "" && status != "all" {
		path += "?status=" + status
	}
	var changes []map[string]any
	if err := client.GetJSON(ctx, path, &changes); err != nil {
		return fmt.Errorf("list change requests: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, changes)
	}
	rows := make([][]string, 0, len(changes))
	for _, c := range changes {
		rows = append(rows, []string{"#" + strVal(c, "number"), strVal(c, "status"), strVal(c, "source"), strVal(c, "author_name"), strVal(c, "title")})
	}
	cli.PrintTable(os.Stdout, []string{"NUMBER", "STATUS", "SOURCE", "AUTHOR", "TITLE"}, rows)

	return nil
}
