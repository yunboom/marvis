package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
)

// rawURIPrefix maps a raw file kind to its raw:// directory.
var rawURIPrefix = map[string]string{"source": "raw://sources/", "asset": "raw://assets/"}

var kbSourcesCmd = &cobra.Command{
	Use:   "sources",
	Short: "List sources (issues, comments, chats, raw files) not yet ingested",
}

var kbSourcesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List sources updated in a period; a source counts as ingested once a claim cites it",
	Long: `List issues, issue comments, chats and raw files that no claim cites yet.
Read their content with the existing commands: marvis issue get / issue
comment list, marvis chat get, marvis kb raw get.`,
	Args: exactArgs(0),
	RunE: runKbSourcesList,
}

var kbRawCmd = &cobra.Command{
	Use:   "raw",
	Short: "List and download raw files (uploaded sources and page assets)",
}

var kbRawListCmd = &cobra.Command{
	Use:   "list <kb>",
	Short: "List a knowledge base's raw files",
	Args:  exactArgs(1),
	RunE:  runKbRawList,
}

var kbRawGetCmd = &cobra.Command{
	Use:   "get <kb> <file name or id>",
	Short: "Download a raw file to read it",
	Args:  exactArgs(2),
	RunE:  runKbRawGet,
}

var kbAnnotationCmd = &cobra.Command{
	Use:   "annotation",
	Short: "Record and list annotations: missing or wrong knowledge",
}

var kbAnnotationAddCmd = &cobra.Command{
	Use:   "add <kb>",
	Short: "Record an annotation on a sentence, a page or the whole knowledge base",
	Args:  exactArgs(1),
	RunE:  runKbAnnotationAdd,
}

var kbAnnotationListCmd = &cobra.Command{
	Use:   "list <kb>",
	Short: "List annotations",
	Args:  exactArgs(1),
	RunE:  runKbAnnotationList,
}

var kbAnnotationDismissCmd = &cobra.Command{
	Use:   "dismiss <annotation-id>",
	Short: "Mark an annotation as not handled",
	Args:  exactArgs(1),
	RunE:  func(cmd *cobra.Command, args []string) error { return runKbAnnotationStatus(cmd, args[0], "dismissed") },
}

var kbAnnotationReopenCmd = &cobra.Command{
	Use:   "reopen <annotation-id>",
	Short: "Put a dismissed annotation back to pending",
	Args:  exactArgs(1),
	RunE:  func(cmd *cobra.Command, args []string) error { return runKbAnnotationStatus(cmd, args[0], "pending") },
}

var kbMRCmd = &cobra.Command{
	Use:   "mr",
	Short: "Create, review and merge merge requests",
}

var kbMRCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a merge request from a draft",
	Args:  exactArgs(0),
	RunE:  runKbMRCreate,
}

var kbMRUpdateCmd = &cobra.Command{
	Use:   "update <number>",
	Short: "Change a merge request's title, summary or risk; content changes go into its draft",
	Args:  exactArgs(1),
	RunE:  runKbMRUpdate,
}

var kbMRListCmd = &cobra.Command{
	Use:   "list",
	Short: "List merge requests",
	Args:  exactArgs(0),
	RunE:  runKbMRList,
}

var kbMRGetCmd = &cobra.Command{
	Use:   "get <number>",
	Short: "Show a merge request with its status, review summaries, changes and checks",
	Args:  exactArgs(1),
	RunE:  runKbMRGet,
}

var kbMRCommentCmd = &cobra.Command{
	Use:   "comment",
	Short: "List and add merge request comments",
}

var kbMRCommentListCmd = &cobra.Command{
	Use:   "list <number>",
	Short: "List a merge request's submitted reviews (with their summaries) and published comments",
	Args:  exactArgs(1),
	RunE:  runKbMRCommentList,
}

var kbMRCommentAddCmd = &cobra.Command{
	Use:   "add <number>",
	Short: "Reply to review feedback as the merge request's owner; reply under a comment with --parent",
	Long: `Post a published comment on a merge request. Only the owner of the merge
request (the member who created its draft, or an agent acting for them) may;
reviewers leave feedback through a review on the review page.`,
	Args: exactArgs(1),
	RunE: runKbMRCommentAdd,
}

var kbMRReadyCmd = &cobra.Command{
	Use:   "ready <number>",
	Short: "Ask for review again after addressing the feedback of a changes_requested merge request",
	Args:  exactArgs(1),
	RunE:  runKbMRReady,
}

var kbMRMergeCmd = &cobra.Command{
	Use:   "merge <number>",
	Short: "Merge a merge request; refused when its draft changed since --draft-version",
	Args:  exactArgs(1),
	RunE:  runKbMRMerge,
}

var kbMRCloseCmd = &cobra.Command{
	Use:   "close <number>",
	Short: "Close a merge request without merging",
	Args:  exactArgs(1),
	RunE:  runKbMRClose,
}

var kbMRRevertCmd = &cobra.Command{
	Use:   "revert <number>",
	Short: "Open a merge request that reverts a merged one",
	Args:  exactArgs(1),
	RunE:  runKbMRRevert,
}

func init() {
	kbSourcesCmd.AddCommand(kbSourcesListCmd)
	kbSourcesListCmd.Flags().String("kb", "", "Knowledge base slug or ID")
	kbSourcesListCmd.Flags().String("since", "", "RFC3339 time with zone; only sources updated after it (the last run time for scheduled ingests)")
	kbSourcesListCmd.Flags().String("kinds", "", "Comma-separated kinds: task, comment, chat, raw; all when omitted")
	kbSourcesListCmd.Flags().Bool("ingested", false, "Also list sources already cited by a claim")
	addKbPaging(kbSourcesListCmd)
	addKbOutput(kbSourcesListCmd, kbOutputTable)

	kbRawCmd.AddCommand(kbRawListCmd, kbRawGetCmd)
	kbRawListCmd.Flags().String("kind", "", "source (uploaded sources) or asset (images and attachments of pages); all when omitted")
	addKbOutput(kbRawListCmd, kbOutputJSON)
	kbRawGetCmd.Flags().String("out", ".", "Directory to download into")
	addKbOutput(kbRawGetCmd, kbOutputJSON)

	kbAnnotationCmd.AddCommand(kbAnnotationAddCmd, kbAnnotationListCmd, kbAnnotationDismissCmd, kbAnnotationReopenCmd)
	kbAnnotationAddCmd.Flags().String("page", "", "Page reference; omit for a gap in the whole knowledge base")
	kbAnnotationAddCmd.Flags().String("block", "", "Block ID of the sentence, when annotating one sentence")
	kbAnnotationAddCmd.Flags().String("quote", "", "The sentence, exactly as it appears in the block")
	kbAnnotationAddCmd.Flags().String("body", "", "What is missing or wrong, with the evidence")
	addKbOutput(kbAnnotationAddCmd, kbOutputJSON)
	kbAnnotationListCmd.Flags().String("status", "pending", "pending or all")
	kbAnnotationListCmd.Flags().String("page", "", "Page reference; - for knowledge-base-level annotations only")
	addKbOutput(kbAnnotationListCmd, kbOutputJSON)
	addKbOutput(kbAnnotationDismissCmd, kbOutputJSON)
	addKbOutput(kbAnnotationReopenCmd, kbOutputJSON)

	kbMRCmd.AddCommand(kbMRCreateCmd, kbMRUpdateCmd, kbMRListCmd, kbMRGetCmd, kbMRCommentCmd, kbMRMergeCmd, kbMRCloseCmd, kbMRRevertCmd, kbMRReadyCmd)
	kbMRCommentCmd.AddCommand(kbMRCommentListCmd, kbMRCommentAddCmd)

	kbMRCreateCmd.Flags().String("draft", "", kbDraftFlagHelp)
	kbMRCreateCmd.Flags().String("source", "", "ingest, health, merge, annotations, new_page or custom")
	kbMRCreateCmd.Flags().StringArray("annotation", nil, "ID of an annotation this change handles (repeatable); resolved on merge")
	for _, c := range []*cobra.Command{kbMRCreateCmd, kbMRUpdateCmd} {
		c.Flags().String("title", "", "Merge request title: what this merge changes")
		addKbTextFlags(c, "summary", "Summary Markdown: what changed and why, and the annotations handled")
		c.Flags().String("risk", "", "low (wording, links), medium (new or changed facts) or high (deleted pages, changed procedures)")
		addKbExternalFileFlag(c)
		addKbOutput(c, kbOutputJSON)
	}

	kbMRListCmd.Flags().String("status", "", "open, changes_requested, merged, closed or all; open and changes_requested when omitted")
	kbMRListCmd.Flags().String("kb", "", "Knowledge base slug or ID")
	kbMRListCmd.Flags().Int("limit", 50, "Rows per call")
	kbMRListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")
	addKbOutput(kbMRListCmd, kbOutputJSON)
	addKbOutput(kbMRGetCmd, kbOutputJSON)

	addKbOutput(kbMRCommentListCmd, kbOutputJSON)
	kbMRCommentListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")
	addKbTextFlags(kbMRCommentAddCmd, "content", "Comment Markdown")
	kbMRCommentAddCmd.Flags().String("parent", "", "ID of the comment to reply to")
	kbMRCommentAddCmd.Flags().String("quote-page", "", "Page reference of the quoted block")
	kbMRCommentAddCmd.Flags().String("quote-block", "", "Block ID of the quoted block")
	addKbExternalFileFlag(kbMRCommentAddCmd)
	addKbOutput(kbMRCommentAddCmd, kbOutputJSON)

	kbMRMergeCmd.Flags().Int64("draft-version", -1, "The draft_version from kb mr get; merging is refused when the draft changed since")
	kbMRCloseCmd.Flags().String("reason", "", "Why the merge request is closed")
	for _, c := range []*cobra.Command{kbMRMergeCmd, kbMRCloseCmd, kbMRRevertCmd, kbMRReadyCmd} {
		addKbOutput(c, kbOutputJSON)
	}
}

func runKbSourcesList(cmd *cobra.Command, _ []string) error {
	if err := requireKbFlags(cmd, "kb"); err != nil {
		return err
	}
	ingested := ""
	if all, _ := cmd.Flags().GetBool("ingested"); all {
		ingested = "true"
	}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		path := "/api/kb/sources" + kbQuery(map[string]string{
			"kb":       kbString(cmd, "kb"),
			"since":    kbString(cmd, "since"),
			"kinds":    kbString(cmd, "kinds"),
			"ingested": ingested,
			"limit":    kbInt(cmd, "limit"),
			"offset":   kbInt(cmd, "offset"),
		})
		var sources []map[string]any
		if err := client.GetJSON(ctx, path, &sources); err != nil {
			return fmt.Errorf("list sources: %w", err)
		}

		return kbOutput(cmd, sources, func() {
			rows := make([][]string, len(sources))
			for i, s := range sources {
				rows[i] = []string{strVal(s, "uri"), strVal(s, "kind"), strVal(s, "title"), strVal(s, "updated_at"), strVal(s, "read_with")}
			}
			cli.PrintTable(os.Stdout, []string{"URI", "KIND", "TITLE", "UPDATED", "READ_WITH"}, rows)
		})
	})
}

func runKbRawList(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var files []map[string]any
		path := "/api/kb/bases/" + kbRef(args[0]) + "/raw" + kbQuery(map[string]string{"kind": kbString(cmd, "kind")})
		if err := client.GetJSON(ctx, path, &files); err != nil {
			return fmt.Errorf("list raw files: %w", err)
		}

		return kbOutput(cmd, files, func() {
			rows := make([][]string, len(files))
			for i, f := range files {
				rows[i] = []string{strVal(f, "id"), strVal(f, "kind"), strVal(f, "name"), numVal(f, "size")}
			}
			cli.PrintTable(os.Stdout, []string{"ID", "KIND", "NAME", "SIZE"}, rows)
		})
	})
}

func runKbRawGet(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var files []map[string]any
		if err := client.GetJSON(ctx, "/api/kb/bases/"+kbRef(args[0])+"/raw", &files); err != nil {
			return fmt.Errorf("list raw files: %w", err)
		}

		var file map[string]any
		for _, f := range files {
			if strVal(f, "id") == args[1] || strVal(f, "name") == args[1] {
				file = f
				break
			}
		}
		if file == nil {
			return fmt.Errorf("no raw file named %q in %s", args[1], args[0])
		}

		data, err := client.DownloadFile(ctx, "/api/kb/raw/"+kbRef(strVal(file, "id"))+"/content")
		if err != nil {
			return fmt.Errorf("download raw file: %w", err)
		}
		dest := filepath.Join(kbString(cmd, "out"), filepath.Base(strVal(file, "name")))
		if err := os.WriteFile(dest, data, 0o644); err != nil {
			return fmt.Errorf("save raw file: %w", err)
		}

		return kbOutput(cmd, map[string]any{
			"id":           strVal(file, "id"),
			"name":         strVal(file, "name"),
			"uri":          rawURIPrefix[strVal(file, "kind")] + strVal(file, "name"),
			"saved_to":     dest,
			"size":         len(data),
			"content_type": strVal(file, "content_type"),
		}, nil)
	})
}

func runKbAnnotationAdd(cmd *cobra.Command, args []string) error {
	if err := requireKbFlags(cmd, "body"); err != nil {
		return err
	}
	if (kbString(cmd, "block") != "" || kbString(cmd, "quote") != "") && kbString(cmd, "page") == "" {
		return fmt.Errorf("--block and --quote need --page")
	}
	body := map[string]any{"body": kbString(cmd, "body")}
	for flag, key := range map[string]string{"page": "page", "block": "block_id", "quote": "quote"} {
		if v := kbString(cmd, flag); v != "" {
			body[key] = v
		}
	}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var created map[string]any
		if err := client.PostJSON(ctx, "/api/kb/bases/"+kbRef(args[0])+"/annotations", body, &created); err != nil {
			return fmt.Errorf("add annotation: %w", err)
		}

		return kbOutput(cmd, created, nil)
	})
}

func runKbAnnotationList(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		path := "/api/kb/bases/" + kbRef(args[0]) + "/annotations" + kbQuery(map[string]string{
			"status": kbString(cmd, "status"),
			"page":   kbString(cmd, "page"),
		})
		var list any
		if err := client.GetJSON(ctx, path, &list); err != nil {
			return fmt.Errorf("list annotations: %w", err)
		}

		return kbOutput(cmd, list, nil)
	})
}

func runKbAnnotationStatus(cmd *cobra.Command, id, status string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var updated map[string]any
		if err := client.PatchJSON(ctx, "/api/kb/annotations/"+kbRef(id), map[string]any{"status": status}, &updated); err != nil {
			return fmt.Errorf("update annotation: %w", err)
		}

		return kbOutput(cmd, updated, nil)
	})
}

// kbMRFields collects title, summary and risk flags that were given.
func kbMRFields(cmd *cobra.Command) (map[string]any, error) {
	body := map[string]any{}
	for _, name := range []string{"title", "risk"} {
		if v := kbString(cmd, name); v != "" {
			body[name] = v
		}
	}
	summary, ok, err := resolveTextFlag(cmd, "summary")
	if err != nil {
		return nil, err
	}
	if ok {
		body["summary"] = summary
	}

	return body, nil
}

func runKbMRCreate(cmd *cobra.Command, _ []string) error {
	if err := requireKbFlags(cmd, "draft", "title", "risk", "source"); err != nil {
		return err
	}
	body, err := kbMRFields(cmd)
	if err != nil {
		return err
	}
	if _, ok := body["summary"]; !ok {
		return fmt.Errorf("--summary, --summary-file or --summary-stdin is required")
	}
	annotations, _ := cmd.Flags().GetStringArray("annotation")
	if annotations == nil {
		annotations = []string{}
	}
	body["draft_id"] = kbString(cmd, "draft")
	body["source"] = kbString(cmd, "source")
	body["annotation_ids"] = annotations

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var created map[string]any
		if err := client.PostJSON(ctx, "/api/kb/merge-requests", body, &created); err != nil {
			return fmt.Errorf("create merge request: %w", err)
		}

		return kbOutput(cmd, created, nil)
	})
}

func runKbMRUpdate(cmd *cobra.Command, args []string) error {
	body, err := kbMRFields(cmd)
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --title, --summary* or --risk")
	}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var updated map[string]any
		if err := client.PatchJSON(ctx, "/api/kb/merge-requests/"+kbRef(args[0]), body, &updated); err != nil {
			return fmt.Errorf("update merge request: %w", err)
		}

		return kbOutput(cmd, updated, nil)
	})
}

func runKbMRList(cmd *cobra.Command, _ []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		path := "/api/kb/merge-requests" + kbQuery(map[string]string{
			"status": kbString(cmd, "status"),
			"kb":     kbString(cmd, "kb"),
			"limit":  kbInt(cmd, "limit"),
		})
		var list any
		if err := client.GetJSON(ctx, path, &list); err != nil {
			return fmt.Errorf("list merge requests: %w", err)
		}

		return kbOutput(cmd, list, func() { printKbMRTable(cmd, list) })
	})
}

// printKbMRTable prints merge requests whether the endpoint answers with an
// array or an object holding one.
func printKbMRTable(cmd *cobra.Command, list any) {
	items, _ := list.([]any)
	if obj, ok := list.(map[string]any); ok {
		for _, key := range []string{"merge_requests", "items"} {
			if arr, ok := obj[key].([]any); ok {
				items = arr
			}
		}
	}

	rows := make([][]string, 0, len(items))
	for _, raw := range items {
		mr, _ := raw.(map[string]any)
		rows = append(rows, []string{numVal(mr, "number"), displayID(strVal(mr, "id"), kbFullID(cmd)), strVal(mr, "title"), strVal(mr, "status"), strVal(mr, "risk"), strVal(mr, "author_name"), strVal(mr, "updated_at")})
	}
	cli.PrintTable(os.Stdout, []string{"NUMBER", "ID", "TITLE", "STATUS", "RISK", "AUTHOR", "UPDATED"}, rows)
}

func runKbMRGet(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var mr map[string]any
		if err := client.GetJSON(ctx, "/api/kb/merge-requests/"+kbRef(args[0]), &mr); err != nil {
			return fmt.Errorf("get merge request: %w", err)
		}

		return kbOutput(cmd, mr, nil)
	})
}

// kbReviewStateSubmitted is a published review (kb_mr_review.state).
const kbReviewStateSubmitted = "submitted"

// runKbMRCommentList prints the feedback everyone can see: the submitted
// reviews with their summaries, and the published comments. The caller's
// own pending review is left out.
func runKbMRCommentList(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		base := "/api/kb/merge-requests/" + kbRef(args[0])
		var comments []map[string]any
		if err := client.GetJSON(ctx, base+"/comments?state=published", &comments); err != nil {
			return fmt.Errorf("list merge request comments: %w", err)
		}
		var all []map[string]any
		if err := client.GetJSON(ctx, base+"/reviews", &all); err != nil {
			return fmt.Errorf("list merge request reviews: %w", err)
		}

		reviews := make([]map[string]any, 0, len(all))
		for _, rv := range all {
			if strVal(rv, "state") == kbReviewStateSubmitted {
				reviews = append(reviews, rv)
			}
		}
		out := map[string]any{"reviews": reviews, "comments": comments}

		return kbOutput(cmd, out, func() {
			full := kbFullID(cmd)
			reviewRows := make([][]string, len(reviews))
			for i, rv := range reviews {
				reviewRows[i] = []string{displayID(strVal(rv, "id"), full), strVal(rv, "reviewer_name"), numVal(rv, "comment_count"), strVal(rv, "summary"), strVal(rv, "submitted_at")}
			}
			cli.PrintTable(os.Stdout, []string{"REVIEW", "REVIEWER", "COMMENTS", "SUMMARY", "SUBMITTED"}, reviewRows)
			_, _ = fmt.Fprintln(os.Stdout)

			commentRows := make([][]string, len(comments))
			for i, c := range comments {
				quote := ""
				if q, ok := c["quote"].(map[string]any); ok {
					quote = strVal(q, "text")
				}
				commentRows[i] = []string{displayID(strVal(c, "id"), full), displayID(strVal(c, "parent_id"), full), strVal(c, "author_name"), quote, strVal(c, "body")}
			}
			cli.PrintTable(os.Stdout, []string{"ID", "PARENT", "AUTHOR", "QUOTE", "BODY"}, commentRows)
		})
	})
}

func runKbMRReady(cmd *cobra.Command, args []string) error {
	return kbMRAction(cmd, args[0], "ready", map[string]any{})
}

func runKbMRCommentAdd(cmd *cobra.Command, args []string) error {
	content, ok, err := resolveTextFlag(cmd, "content")
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("--content, --content-file or --content-stdin is required")
	}
	if (kbString(cmd, "quote-page") == "") != (kbString(cmd, "quote-block") == "") {
		return fmt.Errorf("--quote-page and --quote-block go together")
	}
	body := map[string]any{"body": content}
	for flag, key := range map[string]string{"parent": "parent_id", "quote-page": "quote_page", "quote-block": "quote_block_id"} {
		if v := kbString(cmd, flag); v != "" {
			body[key] = v
		}
	}

	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var created map[string]any
		if err := client.PostJSON(ctx, "/api/kb/merge-requests/"+kbRef(args[0])+"/comments", body, &created); err != nil {
			return fmt.Errorf("add merge request comment: %w", err)
		}

		return kbOutput(cmd, created, nil)
	})
}

func runKbMRMerge(cmd *cobra.Command, args []string) error {
	version, _ := cmd.Flags().GetInt64("draft-version")
	if version < 0 {
		return fmt.Errorf("--draft-version is required: the draft_version from kb mr get")
	}

	return kbMRAction(cmd, args[0], "merge", map[string]any{"draft_version": version})
}

func runKbMRClose(cmd *cobra.Command, args []string) error {
	return kbMRAction(cmd, args[0], "close", map[string]any{"reason": kbString(cmd, "reason")})
}

func runKbMRRevert(cmd *cobra.Command, args []string) error {
	return kbMRAction(cmd, args[0], "revert", map[string]any{})
}

func kbMRAction(cmd *cobra.Command, ref, action string, body map[string]any) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var resp map[string]any
		if err := client.PostJSON(ctx, "/api/kb/merge-requests/"+kbRef(ref)+"/"+action, body, &resp); err != nil {
			return fmt.Errorf("%s merge request: %w", action, err)
		}

		return kbOutput(cmd, resp, nil)
	})
}
