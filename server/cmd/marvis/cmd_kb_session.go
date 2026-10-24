package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
)

var kbMergeCmd = &cobra.Command{
	Use:   "merge <kb>",
	Short: "Ask the maintainer agent to merge duplicate pages or another knowledge base into <kb>",
	Long: `Start a knowledge session in which the maintainer agent merges knowledge and opens a change request.

  marvis kb merge team --pages team/wiki/concepts/a.md,payments/wiki/concepts/b.md
  marvis kb merge team --from payments

The session runs with your account; follow it in the app under Knowledge.`,
	Args: exactArgs(1),
	RunE: runKBMerge,
}

func init() {
	kbCmd.AddCommand(kbMergeCmd)
	kbMergeCmd.Flags().StringSlice("pages", nil, "Duplicate pages to merge (repository paths)")
	kbMergeCmd.Flags().String("from", "", "Knowledge base (slug) to merge into <kb>")
	kbMergeCmd.Flags().String("agent", "", "Agent ID to run the merge; defaults to the knowledge base's maintainer")
}

func runKBMerge(cmd *cobra.Command, args []string) error {
	pages, _ := cmd.Flags().GetStringSlice("pages")
	from, _ := cmd.Flags().GetString("from")
	if (len(pages) < 2) == (from == "") {
		return fmt.Errorf("pass either --pages with at least two pages or --from")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var target map[string]any
	if err := client.GetJSON(ctx, kbBasePath(args[0]), &target); err != nil {
		return fmt.Errorf("get knowledge base %s: %w", args[0], err)
	}
	body := map[string]any{"kind": "merge", "knowledge_base_id": strVal(target, "id")}
	if agent, _ := cmd.Flags().GetString("agent"); agent != "" {
		body["agent_id"] = agent
	}
	var session map[string]any
	if err := client.PostJSON(ctx, "/api/knowledge/sessions", body, &session); err != nil {
		return fmt.Errorf("start merge session: %w", err)
	}
	sessionID := strVal(session, "session_id")

	var message string
	if from != "" {
		message = fmt.Sprintf("Following both AGENTS.md files, merge the knowledge base %s/ into %s/: move pages, remove duplicates, update links, then remove %s/. Self-review and open a change request.",
			from, strVal(target, "slug"), from)
	} else {
		message = "Following the AGENTS.md of the knowledge bases involved, merge these duplicate pages: keep one, turn the other into a pointer, update links, self-review and open a change request:\n- " +
			strings.Join(pages, "\n- ")
	}
	message += fmt.Sprintf("\nKnowledge base directory: %s/ · Session id: %s", strVal(target, "slug"), sessionID)
	if err := client.PostJSON(ctx, "/api/chat/sessions/"+sessionID+"/messages", map[string]any{"content": message}, nil); err != nil {
		return fmt.Errorf("send merge request to session %s: %w", sessionID, err)
	}
	_, err = fmt.Fprintf(os.Stdout, "Started knowledge merge session %s. Review the change request in the app or with marvis kb change list.\n", sessionID)

	return err
}
