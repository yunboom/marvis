package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
)

var kbAnnotateCmd = &cobra.Command{
	Use:   "annotate",
	Short: "Record and list annotations (corrections on a page or one of its sentences)",
}

var kbAnnotateAddCmd = &cobra.Command{
	Use:   "add <kb>",
	Short: "Annotate a page, or one sentence of it with --quote",
	Args:  exactArgs(1),
	RunE:  runKBAnnotateAdd,
}

var kbAnnotateListCmd = &cobra.Command{
	Use:   "list <kb>",
	Short: "List annotations of a knowledge base",
	Args:  exactArgs(1),
	RunE:  runKBAnnotateList,
}

var kbAnnotateDismissCmd = &cobra.Command{
	Use:   "dismiss <annotation-id>",
	Short: "Mark an annotation as not to be handled",
	Args:  exactArgs(1),
	RunE:  func(cmd *cobra.Command, args []string) error { return runKBAnnotateStatus(cmd, args[0], "dismissed") },
}

var kbAnnotateReopenCmd = &cobra.Command{
	Use:   "reopen <annotation-id>",
	Short: "Move a dismissed annotation back to pending",
	Args:  exactArgs(1),
	RunE:  func(cmd *cobra.Command, args []string) error { return runKBAnnotateStatus(cmd, args[0], "pending") },
}

func init() {
	kbCmd.AddCommand(kbAnnotateCmd)
	kbAnnotateCmd.AddCommand(kbAnnotateAddCmd, kbAnnotateListCmd, kbAnnotateDismissCmd, kbAnnotateReopenCmd)

	kbAnnotateAddCmd.Flags().String("page", "", "Page path, e.g. team/wiki/entities/x.md (required)")
	kbAnnotateAddCmd.Flags().String("quote", "", "The exact sentence the annotation is about; omit for a page annotation")
	kbAnnotateAddCmd.Flags().String("body", "", "What is wrong and what it should be (required)")
	kbAnnotateAddCmd.Flags().String("output", "json", "Output format: table or json")
	kbAnnotateListCmd.Flags().String("status", "pending", "Filter: pending, processing, resolved, dismissed or all")
	kbAnnotateListCmd.Flags().String("page", "", "Only annotations of this page")
	kbAnnotateListCmd.Flags().String("output", "table", "Output format: table or json")
	for _, c := range []*cobra.Command{kbAnnotateDismissCmd, kbAnnotateReopenCmd} {
		c.Flags().String("output", "json", "Output format: table or json")
	}
}

func printKBAnnotations(cmd *cobra.Command, anns []map[string]any) error {
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, anns)
	}
	rows := make([][]string, 0, len(anns))
	for _, a := range anns {
		quote := strVal(a, "quote")
		if quote == "" {
			quote = "(page)"
		}
		rows = append(rows, []string{strVal(a, "id"), strVal(a, "status"), strVal(a, "page_path"), quote, strVal(a, "body")})
	}
	cli.PrintTable(os.Stdout, []string{"ID", "STATUS", "PAGE", "QUOTE", "BODY"}, rows)

	return nil
}

func runKBAnnotateAdd(cmd *cobra.Command, args []string) error {
	page, _ := cmd.Flags().GetString("page")
	body, _ := cmd.Flags().GetString("body")
	if page == "" || strings.TrimSpace(body) == "" {
		return fmt.Errorf("--page and --body are required")
	}
	quote, _ := cmd.Flags().GetString("quote")
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var ann map[string]any
	if err := client.PostJSON(ctx, kbBasePath(args[0])+"/annotations", map[string]any{"page_path": page, "quote": quote, "body": body}, &ann); err != nil {
		return fmt.Errorf("add annotation: %w", err)
	}

	return printKBAnnotations(cmd, []map[string]any{ann})
}

func runKBAnnotateList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	q := url.Values{}
	if status, _ := cmd.Flags().GetString("status"); status != "" && status != "all" {
		q.Set("status", status)
	}
	if page, _ := cmd.Flags().GetString("page"); page != "" {
		q.Set("page", page)
	}
	path := kbBasePath(args[0]) + "/annotations"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var anns []map[string]any
	if err := client.GetJSON(ctx, path, &anns); err != nil {
		return fmt.Errorf("list annotations: %w", err)
	}

	return printKBAnnotations(cmd, anns)
}

func runKBAnnotateStatus(cmd *cobra.Command, id, status string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var ann map[string]any
	if err := client.PatchJSON(ctx, "/api/knowledge/annotations/"+url.PathEscape(id), map[string]any{"status": status}, &ann); err != nil {
		return fmt.Errorf("update annotation %s: %w", id, err)
	}

	return printKBAnnotations(cmd, []map[string]any{ann})
}
