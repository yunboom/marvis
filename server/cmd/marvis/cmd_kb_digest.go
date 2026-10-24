package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
)

const (
	kbDigestPath       = "/api/knowledge/digest"
	kbSourcesPath      = "/api/knowledge/sources"
	kbSourceExcerptLen = 80
	autopilotActive    = "active"
	autopilotPaused    = "paused"
)

var kbSourcesCmd = &cobra.Command{
	Use:   "sources",
	Short: "List tasks, comments and your own chats since the last daily knowledge digest, one page at a time",
	Long: "Each page fits in 60% of --context-window tokens; at most 10 pages are returned and \"truncated\" marks the rest.\n" +
		"Pass the since and until of page 1 to later pages so the set does not change while you read.",
	Args: exactArgs(0),
	RunE: runKBSources,
}

var kbDigestCmd = &cobra.Command{
	Use:   "digest",
	Short: "Manage the daily knowledge digest (owner or admin)",
}

var kbDigestGetCmd = &cobra.Command{
	Use:   "get",
	Short: "Show the daily knowledge digest configuration",
	Args:  exactArgs(0),
	RunE:  runKBDigestGet,
}

var kbDigestCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Set up the daily knowledge digest; it starts paused",
	Args:  exactArgs(0),
	RunE:  runKBDigestCreate,
}

var kbDigestUpdateCmd = &cobra.Command{
	Use:   "update",
	Short: "Change the agent, schedule or instructions of the daily knowledge digest",
	Args:  exactArgs(0),
	RunE:  runKBDigestUpdate,
}

var kbDigestEnableCmd = &cobra.Command{
	Use:   "enable",
	Short: "Enable the daily knowledge digest (needs at least one knowledge base)",
	Args:  exactArgs(0),
	RunE:  func(cmd *cobra.Command, _ []string) error { return setKBDigestStatus(cmd, autopilotActive) },
}

var kbDigestDisableCmd = &cobra.Command{
	Use:   "disable",
	Short: "Disable the daily knowledge digest",
	Args:  exactArgs(0),
	RunE:  func(cmd *cobra.Command, _ []string) error { return setKBDigestStatus(cmd, autopilotPaused) },
}

var kbDigestRunCmd = &cobra.Command{
	Use:   "run",
	Short: "Run the daily knowledge digest now",
	Args:  exactArgs(0),
	RunE:  runKBDigestRun,
}

func init() {
	kbCmd.AddCommand(kbSourcesCmd, kbDigestCmd)
	kbDigestCmd.AddCommand(kbDigestGetCmd, kbDigestCreateCmd, kbDigestUpdateCmd, kbDigestEnableCmd, kbDigestDisableCmd, kbDigestRunCmd)

	kbSourcesCmd.Flags().String("since", "", "Start time (RFC3339); defaults to the last completed digest run, or 24 hours ago")
	kbSourcesCmd.Flags().String("until", "", "End time (RFC3339); defaults to now")
	kbSourcesCmd.Flags().Int("page", 1, "Page number, starting at 1")
	kbSourcesCmd.Flags().Int("context-window", 200000, "Your context window in tokens")
	kbSourcesCmd.Flags().String("output", "table", "Output format: table or json")

	for _, c := range []*cobra.Command{kbDigestCreateCmd, kbDigestUpdateCmd} {
		c.Flags().String("agent", "", "Agent ID that runs the digest")
		c.Flags().String("cron", "", "Schedule as a cron expression, e.g. \"0 22 * * *\"")
		c.Flags().String("timezone", "", "IANA timezone of the schedule, e.g. Asia/Shanghai")
	}
	kbDigestUpdateCmd.Flags().String("instructions", "", "Replace the instructions the agent follows")
	for _, c := range []*cobra.Command{kbDigestGetCmd, kbDigestCreateCmd, kbDigestUpdateCmd, kbDigestEnableCmd, kbDigestDisableCmd, kbDigestRunCmd} {
		c.Flags().String("output", "table", "Output format: table or json")
	}
}

func runKBSources(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	q := url.Values{}
	for _, flag := range []string{"since", "until"} {
		if v, _ := cmd.Flags().GetString(flag); v != "" {
			q.Set(flag, v)
		}
	}
	page, _ := cmd.Flags().GetInt("page")
	window, _ := cmd.Flags().GetInt("context-window")
	q.Set("page", strconv.Itoa(page))
	q.Set("context_window", strconv.Itoa(window))

	var resp map[string]any
	if err := client.GetJSON(ctx, kbSourcesPath+"?"+q.Encode(), &resp); err != nil {
		return fmt.Errorf("list knowledge sources: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, resp)
	}

	fmt.Printf("Page %s of %s (since %s, until %s)", strVal(resp, "page"), strVal(resp, "pages"), strVal(resp, "since"), strVal(resp, "until"))
	if truncated, _ := resp["truncated"].(bool); truncated {
		fmt.Print(", truncated")
	}
	fmt.Println()
	items, _ := resp["items"].([]any)
	rows := make([][]string, 0, len(items))
	for _, raw := range items {
		it, _ := raw.(map[string]any)
		rows = append(rows, []string{strVal(it, "at"), strVal(it, "kind"), strVal(it, "uri"), excerpt(strVal(it, "title")+" "+strVal(it, "text"), kbSourceExcerptLen)})
	}
	cli.PrintTable(os.Stdout, []string{"AT", "KIND", "URI", "TEXT"}, rows)

	return nil
}

func excerpt(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}

	return s
}

// fetchKBDigest 读取每日知识沉淀配置；未创建时返回明确的错误，提示先 create。
func fetchKBDigest(ctx context.Context, client *cli.APIClient) (map[string]any, map[string]any, error) {
	var resp map[string]any
	if err := client.GetJSON(ctx, kbDigestPath, &resp); err != nil {
		return nil, nil, fmt.Errorf("get knowledge digest: %w", err)
	}
	ap, _ := resp["autopilot"].(map[string]any)
	if ap == nil {
		return resp, nil, errors.New("the daily knowledge digest is not set up yet; run \"marvis kb digest create --agent <id>\"")
	}

	return resp, ap, nil
}

func printKBDigest(cmd *cobra.Command, resp map[string]any) error {
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(os.Stdout, resp)
	}
	ap, _ := resp["autopilot"].(map[string]any)
	if ap == nil {
		fmt.Println("The daily knowledge digest is not set up.")
		return nil
	}
	schedule, _ := resp["schedule"].(map[string]any)
	rows := [][]string{
		{"ID", strVal(ap, "id")},
		{"Status", strVal(ap, "status")},
		{"Agent", strVal(ap, "assignee_id")},
		{"Schedule", strVal(schedule, "cron_expression") + " " + strVal(schedule, "timezone")},
		{"Knowledge bases", strVal(resp, "knowledge_base_count")},
	}
	if reason := strVal(ap, "pause_reason"); reason != "" {
		rows = append(rows, []string{"Paused because", reason})
	}
	cli.PrintTable(os.Stdout, []string{"FIELD", "VALUE"}, rows)

	return nil
}

func runKBDigestGet(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var resp map[string]any
	if err := client.GetJSON(ctx, kbDigestPath, &resp); err != nil {
		return fmt.Errorf("get knowledge digest: %w", err)
	}

	return printKBDigest(cmd, resp)
}

func runKBDigestCreate(cmd *cobra.Command, _ []string) error {
	agent, _ := cmd.Flags().GetString("agent")
	if agent == "" {
		return errors.New("--agent is required")
	}
	cronExpr, _ := cmd.Flags().GetString("cron")
	tz, _ := cmd.Flags().GetString("timezone")
	if tz == "" {
		tz = time.Local.String()
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var resp map[string]any
	body := map[string]any{"assignee_id": agent, "cron_expression": cronExpr, "timezone": tz}
	if err := client.PostJSON(ctx, kbDigestPath, body, &resp); err != nil {
		return fmt.Errorf("create knowledge digest: %w", err)
	}

	return printKBDigest(cmd, resp)
}

func runKBDigestUpdate(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	resp, ap, err := fetchKBDigest(ctx, client)
	if err != nil {
		return err
	}
	id := strVal(ap, "id")

	patch := map[string]any{}
	if v, _ := cmd.Flags().GetString("agent"); v != "" {
		patch["assignee_id"] = v
	}
	if cmd.Flags().Changed("instructions") {
		v, _ := cmd.Flags().GetString("instructions")
		patch["description"] = v
	}
	if len(patch) > 0 {
		if err := client.PatchJSON(ctx, "/api/autopilots/"+id, patch, nil); err != nil {
			return autopilotWriteRequestError("update knowledge digest", err)
		}
	}

	trigger := map[string]any{}
	if v, _ := cmd.Flags().GetString("cron"); v != "" {
		trigger["cron_expression"] = v
	}
	if v, _ := cmd.Flags().GetString("timezone"); v != "" {
		trigger["timezone"] = v
	}
	if len(trigger) > 0 {
		schedule, _ := resp["schedule"].(map[string]any)
		if schedule == nil {
			return errors.New("the daily knowledge digest has no schedule trigger")
		}
		if err := client.PatchJSON(ctx, "/api/autopilots/"+id+"/triggers/"+strVal(schedule, "id"), trigger, nil); err != nil {
			return autopilotWriteRequestError("update knowledge digest schedule", err)
		}
	}
	if len(patch) == 0 && len(trigger) == 0 {
		return errors.New("nothing to update: pass --agent, --cron, --timezone or --instructions")
	}

	return runKBDigestGet(cmd, nil)
}

func setKBDigestStatus(cmd *cobra.Command, status string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	_, ap, err := fetchKBDigest(ctx, client)
	if err != nil {
		return err
	}

	if err := client.PatchJSON(ctx, "/api/autopilots/"+strVal(ap, "id"), map[string]any{"status": status}, nil); err != nil {
		return autopilotWriteRequestError("update knowledge digest", err)
	}

	return runKBDigestGet(cmd, nil)
}

func runKBDigestRun(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), cli.AtLeastAPITimeout(30*time.Second))
	defer cancel()
	_, ap, err := fetchKBDigest(ctx, client)
	if err != nil {
		return err
	}

	var run map[string]any
	if err := client.PostJSON(ctx, "/api/autopilots/"+strVal(ap, "id")+"/trigger", nil, &run); err != nil {
		return autopilotTriggerRequestError(err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		if err := cli.PrintJSON(os.Stdout, run); err != nil {
			return err
		}
	}
	status := strVal(run, "status")
	if !autopilotRunStarted(status) {
		return fmt.Errorf("daily knowledge digest did not run (status: %s): %s", status, strVal(run, "failure_reason"))
	}
	fmt.Printf("Daily knowledge digest started: run %s\n", strVal(run, "id"))

	return nil
}
