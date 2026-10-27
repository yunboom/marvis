package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
	"github.com/yunboom/marvis/server/internal/util"
)

// Output formats.
const (
	kbOutputJSON  = "json"
	kbOutputTable = "table"
)

// kbDraftFlagHelp is the help of every --draft flag (decision 104).
const kbDraftFlagHelp = "Draft ID (full UUID): the id printed by `kb draft create`"

// kbVersionFlagHelp is the help of every --version flag of a draft write.
const kbVersionFlagHelp = "The version from the page's latest fetch or write: d<number> once the page is in the draft, " +
	"the mainline revision ID (UUID) before that"

var kbCmd = &cobra.Command{
	Use:   "kb",
	Short: "Read and write knowledge bases",
	Long: `Read knowledge bases and write changes to them through drafts.

Pages are written into a draft (kb draft create), checked (kb draft check)
and submitted as a merge request that a person merges. Every output is JSON
unless --output table is given; objects that render as cards carry a
"mention" to paste into replies.`,
}

var kbListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the workspace's knowledge bases",
	Args:  exactArgs(0),
	RunE:  runKbList,
}

var kbGetCmd = &cobra.Command{
	Use:   "get <kb>",
	Short: "Show a knowledge base with its full purpose and schema",
	Args:  exactArgs(1),
	RunE:  runKbGet,
}

var kbCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a knowledge base",
	Args:  exactArgs(0),
	RunE:  runKbCreate,
}

var kbUpdateCmd = &cobra.Command{
	Use:   "update <kb>",
	Short: "Change a knowledge base's name, description, purpose or schema; saving takes effect at once",
	Args:  exactArgs(1),
	RunE:  runKbUpdate,
}

var kbPageCmd = &cobra.Command{
	Use:   "page",
	Short: "Read pages and write them into a draft",
}

var kbPageListCmd = &cobra.Command{
	Use:   "list <kb>",
	Short: "List one level of pages; children are only counted, drill down with --parent",
	Long: `List one level of the page tree, at most --limit pages at a time. When the
output has a next_cursor, pass it to --cursor for the next page, until it is
empty: the pages read together are the complete listing of that level.`,
	Args: exactArgs(1),
	RunE: runKbPageList,
}

var kbPageFetchCmd = &cobra.Command{
	Use:   "fetch <page>",
	Short: "Read a page, or part of it (like lark docs +fetch)",
	Long: `Read a page by reference: <kb slug>:/<path> or a page ID.

Without flags it prints the whole page as Markdown in "content". Use
--detail with-ids to get blocks with IDs before changing the page, and
--scope to read only part of a long page. Pass the printed "version" to the
next write; read with --draft so the version matches the draft.`,
	Args: exactArgs(1),
	RunE: runKbPageFetch,
}

var kbPageCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a page in a draft",
	Args:  exactArgs(0),
	RunE:  runKbPageCreate,
}

var kbPagePatchCmd = &cobra.Command{
	Use:   "patch <page> [key=value ...]",
	Short: "Change a page in a draft by block or by text (like lark docs +update)",
	Long: `Change one page of a draft. Version errors (stale_version) mean the page
changed after you read it: fetch it again and redo the change. Content that
still holds conflict marker lines is refused (conflict_markers).

With --op set_meta, header fields are given as --meta key=value (repeatable)
or as trailing key=value arguments; "key=" removes the key and a value
starting with [ or { is read as JSON.`,
	Args: cobra.MinimumNArgs(1),
	RunE: runKbPagePatch,
}

var kbPageMoveCmd = &cobra.Command{
	Use:   "move <page>",
	Short: "Move or rename a page in a draft",
	Args:  exactArgs(1),
	RunE:  runKbPageMove,
}

var kbPageDeleteCmd = &cobra.Command{
	Use:   "delete <page>",
	Short: "Delete a page in a draft",
	Args:  exactArgs(1),
	RunE:  runKbPageDelete,
}

var kbClaimsCmd = &cobra.Command{
	Use:   "claims",
	Short: "Read and write the claims (fact plus evidence) of pages",
}

var kbClaimsGetCmd = &cobra.Command{
	Use:   "get <page>",
	Short: "Show a page's claims",
	Args:  exactArgs(1),
	RunE:  runKbClaimsGet,
}

var kbClaimsSetCmd = &cobra.Command{
	Use:   "set <page>",
	Short: "Replace a page's claims in a draft; the header sources are regenerated",
	Args:  exactArgs(1),
	RunE:  runKbClaimsSet,
}

var kbClaimsListCmd = &cobra.Command{
	Use:   "list <kb>",
	Short: "Find claims by evidence uri prefix (health checks)",
	Args:  exactArgs(1),
	RunE:  runKbClaimsList,
}

var kbDraftCmd = &cobra.Command{
	Use:   "draft",
	Short: "Create, check and sync drafts",
}

var kbDraftCreateCmd = &cobra.Command{
	Use:   "create <kb>",
	Short: "Create a draft; in a knowledge base job's chat it is linked to that job",
	Long: `Create a draft. Run from a knowledge base job's chat, the draft is linked to
that job and the response carries its job_id. When the job already has a
draft the command fails with job_draft_exists and that draft_id: keep writing
into it. One merge request has one draft: from creating it, submitting it, to
revising it after review, every read and write carries the same draft ID;
however many rounds and pages you change, they all go into this draft.`,
	Args: exactArgs(1),
	RunE: runKbDraftCreate,
}

var kbDraftCheckCmd = &cobra.Command{
	Use:   "check <draft>",
	Short: "Show a draft's changes and checks; exits 1 when a check has an error",
	Args:  exactArgs(1),
	RunE:  runKbDraftCheck,
}

var kbDraftSyncCmd = &cobra.Command{
	Use:   "sync <draft>",
	Short: "Merge the mainline's new changes into a draft (like git merge main); exits 1 on conflicts",
	Long: `Merge what was merged into the mainline since the draft's pages were read.
Pages without conflicts are merged; conflicted blocks get git-style markers
(mainline first, then the draft). Read them with kb page fetch --draft
--detail with-ids and write the resolved text with kb page patch --op
block_replace. Then run kb draft check again.`,
	Args: exactArgs(1),
	RunE: runKbDraftSync,
}

var kbSearchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Hybrid search (keyword + vector) over page titles and text; returns the top hits by relevance with the mode and total",
	Args:  exactArgs(1),
	RunE:  runKbSearch,
}

var kbStaleCmd = &cobra.Command{
	Use:   "stale <kb>",
	Short: "List pages past their review date (health checks)",
	Args:  exactArgs(1),
	RunE:  runKbStale,
}

var kbHistoryCmd = &cobra.Command{
	Use:   "history <kb>",
	Short: "List merged changes of a knowledge base, or of one page with --page",
	Args:  exactArgs(1),
	RunE:  runKbHistory,
}

func init() {
	kbCmd.AddCommand(kbListCmd, kbGetCmd, kbCreateCmd, kbUpdateCmd, kbPageCmd, kbClaimsCmd, kbDraftCmd,
		kbSearchCmd, kbStaleCmd, kbHistoryCmd, kbSourcesCmd, kbRawCmd, kbAnnotationCmd, kbMRCmd)
	kbPageCmd.AddCommand(kbPageListCmd, kbPageFetchCmd, kbPageCreateCmd, kbPagePatchCmd, kbPageMoveCmd, kbPageDeleteCmd)
	kbClaimsCmd.AddCommand(kbClaimsGetCmd, kbClaimsSetCmd, kbClaimsListCmd)
	kbDraftCmd.AddCommand(kbDraftCreateCmd, kbDraftCheckCmd, kbDraftSyncCmd)

	addKbOutput(kbListCmd, kbOutputTable)
	addKbPaging(kbListCmd)
	addKbOutput(kbGetCmd, kbOutputJSON)

	for _, c := range []*cobra.Command{kbCreateCmd, kbUpdateCmd} {
		c.Flags().String("name", "", "Knowledge base name")
		c.Flags().String("description", "", "One-sentence description shown in lists and to agents")
		addKbTextFlags(c, "purpose", "Purpose Markdown: who reads this knowledge base and what belongs in it")
		c.Flags().String("schema-mode", "", "default (the built-in schema) or custom (your own --schema)")
		addKbTextFlags(c, "schema", "Schema Markdown; only with --schema-mode custom")
		addKbExternalFileFlag(c)
		addKbOutput(c, kbOutputJSON)
	}
	kbCreateCmd.Flags().String("slug", "", "Identifier used in page references and links: lowercase letters, numbers and hyphens, unique in the workspace")

	kbPageListCmd.Flags().String("parent", "", "Parent page reference (<kb slug>:/<path> or page ID); top level when omitted")
	kbPageListCmd.Flags().Int("limit", 200, "Pages per call, 1-200")
	kbPageListCmd.Flags().String("cursor", "", "The next_cursor of the previous call, passed back as is")
	kbPageListCmd.Flags().String("type", "", "Page type, case-insensitive; keeps only the pages of this type on the listed level")
	kbPageListCmd.Flags().String("draft", "", kbDraftFlagHelp+"; lists the level as the draft has it, with draft_change on each page")
	kbPageListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")
	addKbOutput(kbPageListCmd, kbOutputTable)

	kbPageFetchCmd.Flags().String("detail", "simple", "simple: Markdown in content; with-ids: blocks with IDs, needed before changing the page")
	kbPageFetchCmd.Flags().String("scope", "full", "full, outline (headings only), section (one heading and what is under it), keyword or range")
	kbPageFetchCmd.Flags().String("start-block-id", "", "section: the heading block; range: the first block")
	kbPageFetchCmd.Flags().String("end-block-id", "", "range: the last block (inclusive); to the end when omitted")
	kbPageFetchCmd.Flags().String("keyword", "", "keyword: words to look for, several separated by |")
	kbPageFetchCmd.Flags().Int("context-before", 0, "Extra blocks before the match")
	kbPageFetchCmd.Flags().Int("context-after", 0, "Extra blocks after the match")
	kbPageFetchCmd.Flags().Int("max-depth", 0, "outline: deepest heading level, 1-6")
	kbPageFetchCmd.Flags().String("revision-id", "", "Read a past revision (revision_id from kb history); not with --draft")
	kbPageFetchCmd.Flags().String("draft", "", kbDraftFlagHelp+"; required when reading a page you are about to change")
	kbPageFetchCmd.Flags().Bool("backlinks", false, "Also list the pages linking to this one")
	addKbOutput(kbPageFetchCmd, kbOutputJSON)

	kbPageCreateCmd.Flags().String("draft", "", kbDraftFlagHelp)
	kbPageCreateCmd.Flags().String("parent", "", "Parent page reference; <kb slug>:/ for the top level")
	kbPageCreateCmd.Flags().String("after", "", "Sibling page reference to place the new page after; last when omitted")
	kbPageCreateCmd.Flags().String("slug", "", "Path segment: lowercase letters, numbers and hyphens, unique among siblings")
	kbPageCreateCmd.Flags().String("type", "", "Page type, one of the common types of the schema's sections when one fits")
	kbPageCreateCmd.Flags().String("title", "", "Page title")
	kbPageCreateCmd.Flags().String("description", "", "One sentence on what the page covers; shown in the page tree and kb page list")
	addKbTextFlags(kbPageCreateCmd, "content", "Page body Markdown")
	addKbExternalFileFlag(kbPageCreateCmd)
	addKbOutput(kbPageCreateCmd, kbOutputJSON)

	kbPagePatchCmd.Flags().String("draft", "", kbDraftFlagHelp)
	kbPagePatchCmd.Flags().String("version", "", kbVersionFlagHelp)
	kbPagePatchCmd.Flags().String("op", "", "block_replace, block_insert_after, block_delete, block_move_after, str_replace, append or set_meta")
	kbPagePatchCmd.Flags().String("block", "", "Target block ID (from fetch --detail with-ids); block_insert_after takes start for the top")
	kbPagePatchCmd.Flags().String("after", "", "block_move_after: the block to move after, or start")
	addKbTextFlags(kbPagePatchCmd, "content", "New Markdown; may hold several blocks")
	kbPagePatchCmd.Flags().String("find", "", "str_replace: text that occurs exactly once on the page")
	kbPagePatchCmd.Flags().String("replace", "", "str_replace: the new text")
	kbPagePatchCmd.Flags().StringArray("meta", nil, "set_meta: header field key=value (repeatable); sources and generated cannot be set")
	addKbExternalFileFlag(kbPagePatchCmd)
	addKbOutput(kbPagePatchCmd, kbOutputJSON)

	for _, c := range []*cobra.Command{kbPageMoveCmd, kbPageDeleteCmd} {
		c.Flags().String("draft", "", kbDraftFlagHelp)
		c.Flags().String("version", "", kbVersionFlagHelp)
		addKbOutput(c, kbOutputJSON)
	}
	kbPageMoveCmd.Flags().String("parent", "", "New parent page reference; <kb slug>:/ for the top level")
	kbPageMoveCmd.Flags().String("after", "", "Sibling page reference to place the page after; last when omitted")
	kbPageMoveCmd.Flags().String("slug", "", "New path segment; unchanged when omitted")

	kbClaimsGetCmd.Flags().String("draft", "", kbDraftFlagHelp+"; reads the draft's claims")
	addKbOutput(kbClaimsGetCmd, kbOutputJSON)
	kbClaimsSetCmd.Flags().String("draft", "", kbDraftFlagHelp)
	kbClaimsSetCmd.Flags().String("version", "", kbVersionFlagHelp)
	kbClaimsSetCmd.Flags().String("file", "", "JSON file with the claims array (same shape as kb claims get); replaces all claims of the page")
	addKbExternalFileFlag(kbClaimsSetCmd)
	addKbOutput(kbClaimsSetCmd, kbOutputJSON)
	kbClaimsListCmd.Flags().String("evidence", "", "Evidence uri prefix: repo://, task://, pr://, chat:// or raw://")
	kbClaimsListCmd.Flags().String("checked-before", "", "RFC3339 time with zone; only claims checked before it")
	addKbPaging(kbClaimsListCmd)
	addKbOutput(kbClaimsListCmd, kbOutputTable)

	kbDraftCreateCmd.Flags().String("title", "", "What this draft changes; unrelated to the merge request title")
	addKbOutput(kbDraftCreateCmd, kbOutputJSON)
	addKbOutput(kbDraftCheckCmd, kbOutputJSON)
	addKbOutput(kbDraftSyncCmd, kbOutputJSON)

	kbSearchCmd.Flags().String("kb", "", "Knowledge base slug or ID; all knowledge bases when omitted")
	kbSearchCmd.Flags().String("type", "", "Page type, case-insensitive")
	kbSearchCmd.Flags().Int("limit", 10, "Top hits by relevance, 1-50; the output's total counts every match")
	kbSearchCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")
	addKbOutput(kbSearchCmd, kbOutputTable)

	addKbPaging(kbStaleCmd)
	addKbOutput(kbStaleCmd, kbOutputTable)

	kbHistoryCmd.Flags().String("page", "", "Page reference; shows that page's history")
	addKbPaging(kbHistoryCmd)
	addKbOutput(kbHistoryCmd, kbOutputTable)

	kbCmd.GroupID = groupCore
	rootCmd.AddCommand(kbCmd)
}

func addKbOutput(c *cobra.Command, def string) {
	c.Flags().String("output", def, "Output format: table or json")
}

func addKbPaging(c *cobra.Command) {
	c.Flags().Int("limit", 50, "Rows per call")
	c.Flags().Int("offset", 0, "Skip the first n rows")
	c.Flags().Bool("full-id", false, "Show full UUIDs in table output")
}

func addKbTextFlags(c *cobra.Command, name, help string) {
	c.Flags().String(name, "", help)
	c.Flags().String(name+"-file", "", help+", read from a UTF-8 file inside the working directory")
	c.Flags().Bool(name+"-stdin", false, help+", read from stdin")
}

func addKbExternalFileFlag(c *cobra.Command) {
	c.Flags().Bool("allow-external-file", false, "Allow file flags to read a path outside the current working directory")
}

// kbCall runs one API call with a fresh client and context.
func kbCall(cmd *cobra.Command, fn func(ctx context.Context, client *cli.APIClient) error) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	if _, err := requireWorkspaceID(cmd); err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	return kbAPIError(fn(ctx, client))
}

// kbErrorBody is the error envelope the CLI prints for failed kb calls.
type kbErrorBody struct {
	Error kbErrorDetail `json:"error"`
}

type kbErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// kbPrintedError has already been printed as JSON; main only sets the exit
// code from the wrapped HTTP error.
type kbPrintedError struct{ err error }

func (e *kbPrintedError) Error() string        { return e.err.Error() }
func (e *kbPrintedError) Unwrap() error        { return e.err }
func (e *kbPrintedError) Is(target error) bool { return target == errSilent }

// kbAPIError prints an HTTP error as {"error": {"code", "message"}} on
// stdout, so agents can branch on the code (stale_version,
// conflict_markers, ...). Other errors pass through.
func kbAPIError(err error) error {
	var httpErr *cli.HTTPError
	if err == nil || !errors.As(err, &httpErr) {
		return err
	}

	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal([]byte(httpErr.Body), &body)
	detail := kbErrorDetail{Code: body.Code, Message: body.Error}
	if detail.Code == "" {
		detail.Code = httpErr.Kind().String()
	}
	if detail.Message == "" {
		detail.Message = httpErr.Body
	}
	if printErr := cli.PrintJSON(os.Stdout, kbErrorBody{Error: detail}); printErr != nil {
		return err
	}

	return &kbPrintedError{err: err}
}

// kbOutput prints JSON, or a table through printTable when --output table.
func kbOutput(cmd *cobra.Command, v any, printTable func()) error {
	output, _ := cmd.Flags().GetString("output")
	if output == kbOutputTable && printTable != nil {
		printTable()
		return nil
	}

	return cli.PrintJSON(os.Stdout, v)
}

// kbRef escapes a knowledge base or page reference for a URL path segment;
// <kb>:/<path> carries slashes.
func kbRef(ref string) string {
	return url.PathEscape(ref)
}

func kbQuery(values map[string]string) string {
	q := url.Values{}
	for k, v := range values {
		if v != "" {
			q.Set(k, v)
		}
	}
	if len(q) == 0 {
		return ""
	}

	return "?" + q.Encode()
}

// kbPage slices a fetched list for --limit / --offset when the endpoint
// returns everything.
func kbPage[T any](cmd *cobra.Command, items []T) []T {
	limit, _ := cmd.Flags().GetInt("limit")
	offset, _ := cmd.Flags().GetInt("offset")
	if offset >= len(items) {
		return []T{}
	}
	items = items[offset:]
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}

	return items
}

func kbFullID(cmd *cobra.Command) bool {
	full, _ := cmd.Flags().GetBool("full-id")
	return full
}

func kbInt(cmd *cobra.Command, name string) string {
	if !cmd.Flags().Changed(name) {
		return ""
	}
	n, _ := cmd.Flags().GetInt(name)

	return strconv.Itoa(n)
}

func kbString(cmd *cobra.Command, name string) string {
	v, _ := cmd.Flags().GetString(name)
	return v
}

func requireKbFlags(cmd *cobra.Command, names ...string) error {
	for _, name := range names {
		if kbString(cmd, name) == "" {
			return fmt.Errorf("--%s is required", name)
		}
	}

	return nil
}

func runKbList(cmd *cobra.Command, _ []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var bases []map[string]any
		if err := client.GetJSON(ctx, "/api/kb/bases", &bases); err != nil {
			return fmt.Errorf("list knowledge bases: %w", err)
		}
		bases = kbPage(cmd, bases)

		return kbOutput(cmd, bases, func() {
			rows := make([][]string, len(bases))
			for i, b := range bases {
				rows[i] = []string{displayID(strVal(b, "id"), kbFullID(cmd)), strVal(b, "name"), strVal(b, "slug"), numVal(b, "page_count"), relativeTimestamp(strVal(b, "updated_at"))}
			}
			cli.PrintTable(os.Stdout, []string{"ID", "NAME", "SLUG", "PAGES", "UPDATED"}, rows)
		})
	})
}

func runKbGet(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var base map[string]any
		if err := client.GetJSON(ctx, "/api/kb/bases/"+kbRef(args[0]), &base); err != nil {
			return fmt.Errorf("get knowledge base: %w", err)
		}

		return kbOutput(cmd, base, func() {
			cli.PrintTable(os.Stdout, []string{"ID", "NAME", "SLUG", "SCHEMA", "PAGES"},
				[][]string{{strVal(base, "id"), strVal(base, "name"), strVal(base, "slug"), strVal(base, "schema_mode"), numVal(base, "page_count")}})
		})
	})
}

// kbConfigBody collects the configuration flags that were given.
func kbConfigBody(cmd *cobra.Command) (map[string]any, error) {
	body := map[string]any{}
	for _, name := range []string{"name", "description"} {
		if cmd.Flags().Changed(name) {
			body[name] = kbString(cmd, name)
		}
	}
	if mode := kbString(cmd, "schema-mode"); mode != "" {
		body["schema_mode"] = mode
	}
	for _, name := range []string{"purpose", "schema"} {
		text, ok, err := resolveTextFlag(cmd, name)
		if err != nil {
			return nil, err
		}
		if ok {
			body[name] = text
		}
	}

	return body, nil
}

func runKbCreate(cmd *cobra.Command, _ []string) error {
	if err := requireKbFlags(cmd, "name", "slug", "schema-mode"); err != nil {
		return err
	}
	body, err := kbConfigBody(cmd)
	if err != nil {
		return err
	}
	body["slug"] = kbString(cmd, "slug")

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var created map[string]any
		if err := client.PostJSON(ctx, "/api/kb/bases", body, &created); err != nil {
			return fmt.Errorf("create knowledge base: %w", err)
		}

		return kbOutput(cmd, created, nil)
	})
}

func runKbUpdate(cmd *cobra.Command, args []string) error {
	body, err := kbConfigBody(cmd)
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --name, --description, --purpose*, --schema-mode or --schema*")
	}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var updated map[string]any
		if err := client.PatchJSON(ctx, "/api/kb/bases/"+kbRef(args[0]), body, &updated); err != nil {
			return fmt.Errorf("update knowledge base: %w", err)
		}

		return kbOutput(cmd, updated, nil)
	})
}

func runKbPageList(cmd *cobra.Command, args []string) error {
	limit, _ := cmd.Flags().GetInt("limit")
	if limit < 1 || limit > 200 {
		return fmt.Errorf("--limit must be between 1 and 200")
	}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		path := "/api/kb/bases/" + kbRef(args[0]) + "/pages" + kbQuery(map[string]string{
			"parent": kbString(cmd, "parent"),
			"limit":  strconv.Itoa(limit),
			"cursor": kbString(cmd, "cursor"),
			"draft":  kbString(cmd, "draft"),
			"type":   kbString(cmd, "type"),
		})
		var level map[string]any
		if err := client.GetJSON(ctx, path, &level); err != nil {
			return fmt.Errorf("list pages: %w", err)
		}

		return kbOutput(cmd, level, func() {
			pages, _ := level["pages"].([]any)
			rows := make([][]string, 0, len(pages))
			for _, raw := range pages {
				p, _ := raw.(map[string]any)
				rows = append(rows, []string{displayID(strVal(p, "id"), kbFullID(cmd)), strVal(p, "path"), strVal(p, "title"), strVal(p, "type"), numVal(p, "child_count"), strVal(p, "draft_change")})
			}
			cli.PrintTable(os.Stdout, []string{"ID", "PATH", "TITLE", "TYPE", "CHILDREN", "DRAFT"}, rows)
			_, _ = fmt.Fprintf(os.Stdout, "total: %v\n", level["total"])
			if next := strVal(level, "next_cursor"); next != "" {
				_, _ = fmt.Fprintf(os.Stdout, "next_cursor: %s\n", next)
			}
		})
	})
}

func runKbPageFetch(cmd *cobra.Command, args []string) error {
	if kbString(cmd, "draft") != "" && kbString(cmd, "revision-id") != "" {
		return fmt.Errorf("--revision-id and --draft cannot be combined")
	}
	backlinks := ""
	if b, _ := cmd.Flags().GetBool("backlinks"); b {
		backlinks = "true"
	}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		path := "/api/kb/pages/" + kbRef(args[0]) + "/fetch" + kbQuery(map[string]string{
			"detail":         kbString(cmd, "detail"),
			"scope":          kbString(cmd, "scope"),
			"start_block_id": kbString(cmd, "start-block-id"),
			"end_block_id":   kbString(cmd, "end-block-id"),
			"keyword":        kbString(cmd, "keyword"),
			"context_before": kbInt(cmd, "context-before"),
			"context_after":  kbInt(cmd, "context-after"),
			"max_depth":      kbInt(cmd, "max-depth"),
			"revision_id":    kbString(cmd, "revision-id"),
			"draft":          kbString(cmd, "draft"),
			"backlinks":      backlinks,
		})
		var page map[string]any
		if err := client.GetJSON(ctx, path, &page); err != nil {
			return fmt.Errorf("fetch page: %w", err)
		}

		return kbOutput(cmd, page, func() {
			blocks, _ := page["blocks"].([]any)
			if len(blocks) == 0 {
				_, _ = fmt.Fprintln(os.Stdout, strVal(page, "content"))
				return
			}
			rows := make([][]string, 0, len(blocks))
			for _, raw := range blocks {
				b, _ := raw.(map[string]any)
				rows = append(rows, []string{strVal(b, "id"), strings.ReplaceAll(strVal(b, "content"), "\n", " ⏎ ")})
			}
			cli.PrintTable(os.Stdout, []string{"BLOCK", "CONTENT"}, rows)
		})
	})
}

func runKbPageCreate(cmd *cobra.Command, _ []string) error {
	if err := requireKbFlags(cmd, "draft", "parent", "slug", "type", "title", "description"); err != nil {
		return err
	}
	content, ok, err := resolveTextFlag(cmd, "content")
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("--content, --content-file or --content-stdin is required")
	}

	body := map[string]any{
		"parent": kbString(cmd, "parent"),
		"after":  kbString(cmd, "after"),
		"slug":   kbString(cmd, "slug"),
		"frontmatter": map[string]any{
			"type":        kbString(cmd, "type"),
			"title":       kbString(cmd, "title"),
			"description": kbString(cmd, "description"),
		},
		"content": content,
	}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var created map[string]any
		if err := client.PostJSON(ctx, "/api/kb/drafts/"+kbRef(kbString(cmd, "draft"))+"/pages", body, &created); err != nil {
			return fmt.Errorf("create page: %w", err)
		}

		return kbOutput(cmd, created, nil)
	})
}

// kbPatchOps are the --op values of kb page patch.
var kbPatchOps = map[string]bool{
	"block_replace": true, "block_insert_after": true, "block_delete": true, "block_move_after": true,
	"str_replace": true, "append": true, "set_meta": true,
}

func runKbPagePatch(cmd *cobra.Command, args []string) error {
	if err := requireKbFlags(cmd, "draft", "version", "op"); err != nil {
		return err
	}
	opName := kbString(cmd, "op")
	if !kbPatchOps[opName] {
		return fmt.Errorf("--op must be one of block_replace, block_insert_after, block_delete, block_move_after, str_replace, append, set_meta")
	}
	if len(args) > 1 && opName != "set_meta" {
		return fmt.Errorf("unexpected arguments %v: key=value arguments are only for --op set_meta", args[1:])
	}

	op, err := kbPatchOp(cmd, opName, args[1:])
	if err != nil {
		return err
	}

	return kbWriteOps(cmd, args[0], op)
}

// kbPatchOp builds the single operation kb page patch sends.
func kbPatchOp(cmd *cobra.Command, opName string, extraMeta []string) (map[string]any, error) {
	op := map[string]any{"op": opName}
	needs := map[string][]string{
		"block_replace":      {"block"},
		"block_insert_after": {"block"},
		"block_delete":       {"block"},
		"block_move_after":   {"block", "after"},
		"str_replace":        {"find"},
	}
	if err := requireKbFlags(cmd, needs[opName]...); err != nil {
		return nil, err
	}
	if block := kbString(cmd, "block"); block != "" {
		op["block"] = block
	}
	if after := kbString(cmd, "after"); after != "" {
		op["after"] = after
	}

	switch opName {
	case "block_replace", "block_insert_after", "append":
		content, ok, err := resolveTextFlag(cmd, "content")
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("--content, --content-file or --content-stdin is required for --op %s", opName)
		}
		op["content"] = content
	case "str_replace":
		if !cmd.Flags().Changed("replace") {
			return nil, fmt.Errorf("--replace is required for --op str_replace")
		}
		op["find"] = util.UnescapeBackslashEscapes(kbString(cmd, "find"))
		op["replace"] = util.UnescapeBackslashEscapes(kbString(cmd, "replace"))
	case "set_meta":
		pairs, _ := cmd.Flags().GetStringArray("meta")
		fields, err := parseKbMeta(append(pairs, extraMeta...))
		if err != nil {
			return nil, err
		}
		op["fields"] = fields
	}

	return op, nil
}

// parseKbMeta turns key=value pairs into header fields: an empty value
// removes the key (null), a value starting with [ or { is JSON.
func parseKbMeta(pairs []string) (map[string]any, error) {
	if len(pairs) == 0 {
		return nil, fmt.Errorf("--op set_meta needs at least one --meta key=value")
	}

	fields := make(map[string]any, len(pairs))
	for _, pair := range pairs {
		key, value, ok := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, fmt.Errorf("invalid meta %q: want key=value", pair)
		}

		switch {
		case value == "":
			fields[key] = nil
		case strings.HasPrefix(value, "[") || strings.HasPrefix(value, "{"):
			var parsed any
			if err := json.Unmarshal([]byte(value), &parsed); err != nil {
				return nil, fmt.Errorf("meta %s: invalid JSON: %w", key, err)
			}
			fields[key] = parsed
		default:
			fields[key] = value
		}
	}

	return fields, nil
}

func runKbPageMove(cmd *cobra.Command, args []string) error {
	if err := requireKbFlags(cmd, "draft", "version", "parent"); err != nil {
		return err
	}
	op := map[string]any{"op": "move", "parent": kbString(cmd, "parent")}
	if after := kbString(cmd, "after"); after != "" {
		op["after"] = after
	}
	if slug := kbString(cmd, "slug"); slug != "" {
		op["slug"] = slug
	}

	return kbWriteOps(cmd, args[0], op)
}

func runKbPageDelete(cmd *cobra.Command, args []string) error {
	if err := requireKbFlags(cmd, "draft", "version"); err != nil {
		return err
	}

	return kbWriteOps(cmd, args[0], map[string]any{"op": "delete"})
}

func kbWriteOps(cmd *cobra.Command, page string, op map[string]any) error {
	body := map[string]any{"version": kbString(cmd, "version"), "ops": []map[string]any{op}}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var resp map[string]any
		path := "/api/kb/drafts/" + kbRef(kbString(cmd, "draft")) + "/pages/" + kbRef(page) + "/ops"
		if err := client.PostJSON(ctx, path, body, &resp); err != nil {
			return fmt.Errorf("write page: %w", err)
		}

		return kbOutput(cmd, resp, nil)
	})
}

func runKbClaimsGet(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var resp map[string]any
		path := "/api/kb/pages/" + kbRef(args[0]) + "/claims" + kbQuery(map[string]string{"draft": kbString(cmd, "draft")})
		if err := client.GetJSON(ctx, path, &resp); err != nil {
			return fmt.Errorf("get claims: %w", err)
		}

		return kbOutput(cmd, resp, nil)
	})
}

func runKbClaimsSet(cmd *cobra.Command, args []string) error {
	if err := requireKbFlags(cmd, "draft", "version", "file"); err != nil {
		return err
	}
	claims, err := readKbClaimsFile(cmd, kbString(cmd, "file"))
	if err != nil {
		return err
	}
	body := map[string]any{"version": kbString(cmd, "version"), "claims": claims}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var resp map[string]any
		path := "/api/kb/drafts/" + kbRef(kbString(cmd, "draft")) + "/pages/" + kbRef(args[0]) + "/claims"
		if err := client.PutJSON(ctx, path, body, &resp); err != nil {
			return fmt.Errorf("set claims: %w", err)
		}

		return kbOutput(cmd, resp, nil)
	})
}

// readKbClaimsFile reads a claims array, or an object with a claims array
// (the output of kb claims get).
func readKbClaimsFile(cmd *cobra.Command, path string) ([]any, error) {
	if err := ensureFileFlagWithinWorkdir(cmd, "file", "file", path); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read --file: %w", err)
	}

	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("--file is not valid JSON: %w", err)
	}
	switch v := parsed.(type) {
	case []any:
		return v, nil
	case map[string]any:
		if claims, ok := v["claims"].([]any); ok {
			return claims, nil
		}
	}

	return nil, fmt.Errorf("--file must hold a claims array")
}

func runKbClaimsList(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		path := "/api/kb/bases/" + kbRef(args[0]) + "/claims" + kbQuery(map[string]string{
			"evidence":       kbString(cmd, "evidence"),
			"checked_before": kbString(cmd, "checked-before"),
			"limit":          kbInt(cmd, "limit"),
			"offset":         kbInt(cmd, "offset"),
		})
		var claims []map[string]any
		if err := client.GetJSON(ctx, path, &claims); err != nil {
			return fmt.Errorf("list claims: %w", err)
		}

		return kbOutput(cmd, claims, func() {
			rows := make([][]string, len(claims))
			for i, c := range claims {
				rows[i] = []string{strVal(c, "path"), strVal(c, "key"), strVal(c, "block_id"), strVal(c, "text"), strVal(c, "checked_at")}
			}
			cli.PrintTable(os.Stdout, []string{"PATH", "KEY", "BLOCK", "TEXT", "CHECKED"}, rows)
		})
	})
}

func runKbDraftCreate(cmd *cobra.Command, args []string) error {
	body := map[string]any{"knowledge_base": args[0], "title": kbString(cmd, "title")}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var draft map[string]any
		if err := client.PostJSON(ctx, "/api/kb/drafts", body, &draft); err != nil {
			return fmt.Errorf("create draft: %w", err)
		}

		return kbOutput(cmd, draft, nil)
	})
}

func runKbDraftCheck(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var draft map[string]any
		if err := client.GetJSON(ctx, "/api/kb/drafts/"+kbRef(args[0]), &draft); err != nil {
			return fmt.Errorf("check draft: %w", err)
		}
		if err := kbOutput(cmd, draft, nil); err != nil {
			return err
		}
		if kbDraftHasErrors(draft) {
			return errSilent
		}

		return nil
	})
}

// kbDraftHasErrors reports an error-level check or an unresolved conflict.
func kbDraftHasErrors(draft map[string]any) bool {
	checks, _ := draft["checks"].(map[string]any)
	if conflicts, _ := checks["conflicts"].([]any); len(conflicts) > 0 {
		return true
	}
	findings, _ := checks["lint"].([]any)
	for _, raw := range findings {
		if f, _ := raw.(map[string]any); strVal(f, "severity") == "error" {
			return true
		}
	}

	return false
}

func runKbDraftSync(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var resp map[string]any
		if err := client.PostJSON(ctx, "/api/kb/drafts/"+kbRef(args[0])+"/sync", map[string]any{}, &resp); err != nil {
			return fmt.Errorf("sync draft: %w", err)
		}
		if err := kbOutput(cmd, resp, nil); err != nil {
			return err
		}
		if n, _ := resp["unresolved"].(float64); n > 0 {
			return errSilent
		}

		return nil
	})
}

func runKbSearch(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		path := "/api/kb/search" + kbQuery(map[string]string{
			"q":     args[0],
			"kb":    kbString(cmd, "kb"),
			"type":  kbString(cmd, "type"),
			"limit": kbInt(cmd, "limit"),
		})
		var resp map[string]any
		if err := client.GetJSON(ctx, path, &resp); err != nil {
			return fmt.Errorf("search: %w", err)
		}

		return kbOutput(cmd, resp, func() {
			hits, _ := resp["hits"].([]any)
			rows := make([][]string, 0, len(hits))
			for _, raw := range hits {
				h, _ := raw.(map[string]any)
				rows = append(rows, []string{displayID(strVal(h, "page_id"), kbFullID(cmd)), strVal(h, "slug") + ":" + strVal(h, "path"), strVal(h, "title"), strVal(h, "excerpt")})
			}
			fmt.Printf("mode: %s  total: %s\n", strVal(resp, "mode"), strVal(resp, "total"))
			cli.PrintTable(os.Stdout, []string{"PAGE", "REF", "TITLE", "EXCERPT"}, rows)
		})
	})
}

func runKbStale(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		path := "/api/kb/bases/" + kbRef(args[0]) + "/stale" + kbQuery(map[string]string{"limit": kbInt(cmd, "limit"), "offset": kbInt(cmd, "offset")})
		var pages []map[string]any
		if err := client.GetJSON(ctx, path, &pages); err != nil {
			return fmt.Errorf("list stale pages: %w", err)
		}

		return kbOutput(cmd, pages, func() {
			rows := make([][]string, len(pages))
			for i, p := range pages {
				rows[i] = []string{displayID(strVal(p, "page_id"), kbFullID(cmd)), strVal(p, "path"), strVal(p, "title"), strVal(p, "stale_after"), numVal(p, "claims")}
			}
			cli.PrintTable(os.Stdout, []string{"PAGE", "PATH", "TITLE", "STALE_AFTER", "CLAIMS"}, rows)
		})
	})
}

func runKbHistory(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		if page := kbString(cmd, "page"); page != "" {
			var items []map[string]any
			if err := client.GetJSON(ctx, "/api/kb/pages/"+kbRef(page)+"/history", &items); err != nil {
				return fmt.Errorf("page history: %w", err)
			}
			items = kbPage(cmd, items)

			return kbOutput(cmd, items, func() {
				rows := make([][]string, len(items))
				for i, it := range items {
					rows[i] = []string{displayID(strVal(it, "revision_id"), kbFullID(cmd)), numVal(it, "mr_number"), strVal(it, "mr_title"), strVal(it, "author_name"), strVal(it, "merged_at")}
				}
				cli.PrintTable(os.Stdout, []string{"REVISION", "MR", "TITLE", "AUTHOR", "MERGED"}, rows)
			})
		}

		path := "/api/kb/merge-requests" + kbQuery(map[string]string{
			"status": "merged",
			"kb":     args[0],
			"limit":  kbInt(cmd, "limit"),
			"offset": kbInt(cmd, "offset"),
		})
		var mrs any
		if err := client.GetJSON(ctx, path, &mrs); err != nil {
			return fmt.Errorf("knowledge base history: %w", err)
		}

		return kbOutput(cmd, mrs, func() { printKbMRTable(cmd, mrs) })
	})
}
