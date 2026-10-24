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

// kbCmd 是知识库命令组。刻意不提供删除：删除只能由 owner / admin 在界面上操作。
var kbCmd = &cobra.Command{
	Use:   "kb",
	Short: "Work with knowledge bases (read, annotate, change, digest)",
	Long: `Work with the workspace knowledge bases.

All knowledge bases of a workspace live as directories of one git repository.
Every change goes through a change request that a workspace owner or admin
merges. Knowledge bases cannot be deleted from the CLI.`,
}

var kbListCmd = &cobra.Command{
	Use:   "list",
	Short: "List knowledge bases in the workspace",
	RunE:  runKBList,
}

var kbGetCmd = &cobra.Command{
	Use:   "get <id-or-slug>",
	Short: "Show one knowledge base",
	Args:  exactArgs(1),
	RunE:  runKBGet,
}

var kbCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a knowledge base with the built-in schema",
	RunE:  runKBCreate,
}

var kbUpdateCmd = &cobra.Command{
	Use:   "update <id-or-slug>",
	Short: "Change a knowledge base's name, description or maintainer agent",
	Args:  exactArgs(1),
	RunE:  runKBUpdate,
}

func init() {
	kbCmd.AddCommand(kbListCmd, kbGetCmd, kbCreateCmd, kbUpdateCmd)

	kbListCmd.Flags().String("output", "table", "Output format: table or json")
	kbGetCmd.Flags().String("output", "json", "Output format: table or json")

	kbCreateCmd.Flags().String("name", "", "Knowledge base name (required)")
	kbCreateCmd.Flags().String("slug", "", "Directory name in the repository (lowercase letters, digits, hyphens); derived from the name when omitted")
	kbCreateCmd.Flags().String("description", "", "What this knowledge base covers; agents decide whether to use it from this")
	kbCreateCmd.Flags().String("purpose", "", "Initial purpose.md body; defaults to the description")
	kbCreateCmd.Flags().String("maintainer-agent", "", "Agent ID that runs knowledge operations by default")
	kbCreateCmd.Flags().String("output", "json", "Output format: table or json")

	kbUpdateCmd.Flags().String("name", "", "New name")
	kbUpdateCmd.Flags().String("description", "", "New description")
	kbUpdateCmd.Flags().String("maintainer-agent", "", "New maintainer agent ID; pass an empty string to clear")
	kbUpdateCmd.Flags().String("output", "json", "Output format: table or json")
}

func kbBasePath(ref string) string {
	return "/api/knowledge/bases/" + url.PathEscape(ref)
}

func printKBBases(cmd *cobra.Command, bases []map[string]any) error {
	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, bases)
	}

	headers := []string{"ID", "SLUG", "NAME", "PAGES", "DESCRIPTION"}
	rows := make([][]string, 0, len(bases))
	for _, b := range bases {
		rows = append(rows, []string{strVal(b, "id"), strVal(b, "slug"), strVal(b, "name"), strVal(b, "page_count"), strVal(b, "description")})
	}
	cli.PrintTable(os.Stdout, headers, rows)

	return nil
}

func runKBList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var bases []map[string]any
	if err := client.GetJSON(ctx, "/api/knowledge/bases", &bases); err != nil {
		return fmt.Errorf("list knowledge bases: %w", err)
	}

	return printKBBases(cmd, bases)
}

func runKBGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var base map[string]any
	if err := client.GetJSON(ctx, kbBasePath(args[0]), &base); err != nil {
		return fmt.Errorf("get knowledge base %s: %w", args[0], err)
	}

	return printKBBases(cmd, []map[string]any{base})
}

func runKBCreate(cmd *cobra.Command, _ []string) error {
	name, _ := cmd.Flags().GetString("name")
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("--name is required")
	}
	body := map[string]any{"name": name}
	for flag, field := range map[string]string{"slug": "slug", "description": "description", "purpose": "purpose", "maintainer-agent": "maintainer_agent_id"} {
		if cmd.Flags().Changed(flag) {
			v, _ := cmd.Flags().GetString(flag)
			body[field] = v
		}
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var base map[string]any
	if err := client.PostJSON(ctx, "/api/knowledge/bases", body, &base); err != nil {
		return fmt.Errorf("create knowledge base: %w", err)
	}

	return printKBBases(cmd, []map[string]any{base})
}

func runKBUpdate(cmd *cobra.Command, args []string) error {
	body := map[string]any{}
	for flag, field := range map[string]string{"name": "name", "description": "description", "maintainer-agent": "maintainer_agent_id"} {
		if cmd.Flags().Changed(flag) {
			v, _ := cmd.Flags().GetString(flag)
			body[field] = v
		}
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --name, --description or --maintainer-agent")
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var base map[string]any
	if err := client.PatchJSON(ctx, kbBasePath(args[0]), body, &base); err != nil {
		return fmt.Errorf("update knowledge base %s: %w", args[0], err)
	}

	return printKBBases(cmd, []map[string]any{base})
}
