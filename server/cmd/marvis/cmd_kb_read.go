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

var kbPageCmd = &cobra.Command{
	Use:   "page",
	Short: "Read knowledge base pages",
}

var kbPageListCmd = &cobra.Command{
	Use:   "list <kb>",
	Short: "List the pages of a knowledge base",
	Args:  exactArgs(1),
	RunE:  runKBPageList,
}

var kbPageGetCmd = &cobra.Command{
	Use:   "get <kb> <path>",
	Short: "Show one page (path relative to the repository root, e.g. team/wiki/entities/x.md)",
	Args:  exactArgs(2),
	RunE:  runKBPageGet,
}

var kbSearchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Search all knowledge bases; a query with no hits is recorded as a knowledge gap",
	Args:  exactArgs(1),
	RunE:  runKBSearch,
}

var kbGapCmd = &cobra.Command{
	Use:   "gap",
	Short: "Record and list knowledge gaps (questions the knowledge bases cannot answer yet)",
}

var kbGapAddCmd = &cobra.Command{
	Use:   "add <question>",
	Short: "Record a knowledge gap",
	Args:  exactArgs(1),
	RunE:  runKBGapAdd,
}

var kbGapListCmd = &cobra.Command{
	Use:   "list",
	Short: "List knowledge gaps",
	RunE:  runKBGapList,
}

var kbGapUpdateCmd = &cobra.Command{
	Use:   "update <gap-id>",
	Short: "Change a knowledge gap's status",
	Args:  exactArgs(1),
	RunE:  runKBGapUpdate,
}

func init() {
	kbCmd.AddCommand(kbPageCmd, kbSearchCmd, kbGapCmd)
	kbPageCmd.AddCommand(kbPageListCmd, kbPageGetCmd)
	kbGapCmd.AddCommand(kbGapAddCmd, kbGapListCmd, kbGapUpdateCmd)

	kbPageListCmd.Flags().String("output", "table", "Output format: table or json")
	kbPageGetCmd.Flags().String("output", "markdown", "Output format: markdown or json")
	kbSearchCmd.Flags().String("kb", "", "Only search this knowledge base (slug)")
	kbSearchCmd.Flags().Int("limit", 10, "Maximum number of results (1-50)")
	kbSearchCmd.Flags().Bool("no-record-miss", false, "Do not record a knowledge gap when nothing matches")
	kbSearchCmd.Flags().String("output", "table", "Output format: table or json")
	kbGapListCmd.Flags().String("status", "", "Filter by status: open, processing or filled")
	kbGapListCmd.Flags().String("output", "table", "Output format: table or json")
	kbGapAddCmd.Flags().String("output", "json", "Output format: table or json")
	kbGapUpdateCmd.Flags().String("status", "", "New status: open, processing or filled (required)")
	kbGapUpdateCmd.Flags().String("output", "json", "Output format: table or json")
}

func runKBPageList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var resp struct {
		Pages []map[string]any `json:"pages"`
	}
	if err := client.GetJSON(ctx, kbBasePath(args[0])+"/pages", &resp); err != nil {
		return fmt.Errorf("list pages of %s: %w", args[0], err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, resp.Pages)
	}

	rows := make([][]string, 0, len(resp.Pages))
	for _, p := range resp.Pages {
		rows = append(rows, []string{strVal(p, "path"), strVal(p, "title"), strVal(p, "type"), strVal(p, "open_annotations")})
	}
	cli.PrintTable(os.Stdout, []string{"PATH", "TITLE", "TYPE", "OPEN_ANNOTATIONS"}, rows)

	return nil
}

func runKBPageGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var page map[string]any
	if err := client.GetJSON(ctx, kbBasePath(args[0])+"/page?path="+url.QueryEscape(args[1]), &page); err != nil {
		return fmt.Errorf("get page %s: %w", args[1], err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, page)
	}
	_, err = fmt.Fprint(os.Stdout, strVal(page, "markdown"))

	return err
}

func runKBSearch(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	q := url.Values{"q": {args[0]}}
	if kb, _ := cmd.Flags().GetString("kb"); kb != "" {
		q.Set("kb", kb)
	}
	if limit, _ := cmd.Flags().GetInt("limit"); limit > 0 {
		q.Set("limit", fmt.Sprint(limit))
	}
	if noRecord, _ := cmd.Flags().GetBool("no-record-miss"); !noRecord {
		q.Set("record_miss", "1")
	}

	var resp struct {
		Hits []map[string]any `json:"hits"`
		Gap  map[string]any   `json:"gap"`
	}
	if err := client.GetJSON(ctx, "/api/knowledge/search?"+q.Encode(), &resp); err != nil {
		return fmt.Errorf("search knowledge: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, resp)
	}

	if len(resp.Hits) == 0 {
		msg := "No matching pages."
		if resp.Gap != nil {
			msg += " Recorded as knowledge gap " + strVal(resp.Gap, "id") + "."
		}
		_, err := fmt.Fprintln(os.Stdout, msg)
		return err
	}
	rows := make([][]string, 0, len(resp.Hits))
	for _, h := range resp.Hits {
		rows = append(rows, []string{strVal(h, "path"), strVal(h, "title"), strVal(h, "excerpt")})
	}
	cli.PrintTable(os.Stdout, []string{"PATH", "TITLE", "EXCERPT"}, rows)

	return nil
}

func printKBGaps(cmd *cobra.Command, gaps []map[string]any) error {
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, gaps)
	}
	rows := make([][]string, 0, len(gaps))
	for _, g := range gaps {
		rows = append(rows, []string{strVal(g, "id"), strVal(g, "status"), strVal(g, "source"), strVal(g, "question")})
	}
	cli.PrintTable(os.Stdout, []string{"ID", "STATUS", "SOURCE", "QUESTION"}, rows)

	return nil
}

func runKBGapAdd(cmd *cobra.Command, args []string) error {
	if strings.TrimSpace(args[0]) == "" {
		return fmt.Errorf("question is required")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var gap map[string]any
	if err := client.PostJSON(ctx, "/api/knowledge/gaps", map[string]any{"question": args[0]}, &gap); err != nil {
		return fmt.Errorf("record knowledge gap: %w", err)
	}

	return printKBGaps(cmd, []map[string]any{gap})
}

func runKBGapList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	path := "/api/knowledge/gaps"
	if status, _ := cmd.Flags().GetString("status"); status != "" {
		path += "?status=" + url.QueryEscape(status)
	}
	var gaps []map[string]any
	if err := client.GetJSON(ctx, path, &gaps); err != nil {
		return fmt.Errorf("list knowledge gaps: %w", err)
	}

	return printKBGaps(cmd, gaps)
}

func runKBGapUpdate(cmd *cobra.Command, args []string) error {
	status, _ := cmd.Flags().GetString("status")
	if status == "" {
		return fmt.Errorf("--status is required")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var gap map[string]any
	if err := client.PatchJSON(ctx, "/api/knowledge/gaps/"+url.PathEscape(args[0]), map[string]any{"status": status}, &gap); err != nil {
		return fmt.Errorf("update knowledge gap %s: %w", args[0], err)
	}

	return printKBGaps(cmd, []map[string]any{gap})
}
