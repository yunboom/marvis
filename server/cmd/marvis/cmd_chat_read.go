package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
)

var chatListCmd = &cobra.Command{
	Use:   "list",
	Short: "List chats you can read; --scope workspace reads every member's chats when allowed",
	Long: `List chats. Without --scope only the chats you started are listed. With
--scope workspace every member's chats are listed, which only a workspace
owner may do, or an agent that only its owner can use whose owner is a
workspace owner. Cite a chat in a page only as the neutral label "chat":
never quote or summarise it.`,
	Args: exactArgs(0),
	RunE: runChatList,
}

var chatGetCmd = &cobra.Command{
	Use:   "get <session-id>",
	Short: "Read the messages of a chat",
	Args:  exactArgs(1),
	RunE:  runChatGet,
}

func init() {
	chatListCmd.Flags().String("scope", "mine", "mine (the chats you started) or workspace (every member's chats, when allowed)")
	chatListCmd.Flags().String("since", "", "RFC3339 time with zone; only chats with messages after it")
	chatListCmd.Flags().String("agent", "", "Agent ID or name; only chats with this agent")
	chatListCmd.Flags().Int("limit", 50, "Rows per call")
	chatListCmd.Flags().Int("offset", 0, "Skip the first n rows")
	chatListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")
	chatListCmd.Flags().String("output", kbOutputTable, "Output format: table or json")

	chatGetCmd.Flags().String("scope", "", "workspace to read a chat someone else started (when allowed)")
	chatGetCmd.Flags().String("since", "", "RFC3339 time with zone; only messages after it")
	chatGetCmd.Flags().Int("limit", 50, "Most messages to return")
	chatGetCmd.Flags().String("output", kbOutputJSON, "Output format: table or json")

	chatCmd.AddCommand(chatListCmd, chatGetCmd)
}

func runChatList(cmd *cobra.Command, _ []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		agentID := ""
		if agent := kbString(cmd, "agent"); agent != "" {
			id, err := resolveAgent(ctx, client, agent)
			if err != nil {
				return fmt.Errorf("resolve agent: %w", err)
			}
			agentID = id
		}
		scope := kbString(cmd, "scope")
		if scope == "mine" {
			scope = ""
		}

		path := "/api/chat/sessions" + kbQuery(map[string]string{
			"scope":    scope,
			"since":    kbString(cmd, "since"),
			"agent_id": agentID,
			"limit":    kbInt(cmd, "limit"),
			"offset":   kbInt(cmd, "offset"),
		})
		var sessions []map[string]any
		if err := client.GetJSON(ctx, path, &sessions); err != nil {
			return fmt.Errorf("list chats: %w", err)
		}

		return kbOutput(cmd, sessions, func() {
			rows := make([][]string, len(sessions))
			for i, s := range sessions {
				last, _ := s["last_message"].(map[string]any)
				rows[i] = []string{displayID(strVal(s, "id"), kbFullID(cmd)), strVal(s, "title"), displayID(strVal(s, "agent_id"), kbFullID(cmd)),
					displayID(strVal(s, "creator_id"), kbFullID(cmd)), relativeTimestamp(strVal(last, "created_at"))}
			}
			cli.PrintTable(os.Stdout, []string{"ID", "TITLE", "AGENT", "CREATOR", "LAST_MESSAGE"}, rows)
		})
	})
}

func runChatGet(cmd *cobra.Command, args []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		path := "/api/chat/sessions/" + kbRef(args[0]) + "/messages/page" + kbQuery(map[string]string{
			"scope": kbString(cmd, "scope"),
			"since": kbString(cmd, "since"),
			"limit": kbInt(cmd, "limit"),
		})
		var page map[string]any
		if err := client.GetJSON(ctx, path, &page); err != nil {
			return fmt.Errorf("read chat: %w", err)
		}

		return kbOutput(cmd, page, func() {
			messages, _ := page["messages"].([]any)
			rows := make([][]string, 0, len(messages))
			for _, raw := range messages {
				m, _ := raw.(map[string]any)
				rows = append(rows, []string{strVal(m, "created_at"), strVal(m, "role"), strings.ReplaceAll(strVal(m, "content"), "\n", " ")})
			}
			cli.PrintTable(os.Stdout, []string{"AT", "ROLE", "CONTENT"}, rows)
		})
	})
}
