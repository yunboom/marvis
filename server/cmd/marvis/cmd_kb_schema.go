package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
)

var kbSchemaCmd = &cobra.Command{
	Use:   "schema",
	Short: "Built-in knowledge base schemas",
}

var kbSchemaTemplatesCmd = &cobra.Command{
	Use:   "templates",
	Short: "Show the platform's built-in default schema, a reference when writing a schema",
	Args:  exactArgs(0),
	RunE:  runKbSchemaTemplates,
}

func init() {
	kbCmd.AddCommand(kbSchemaCmd)
	kbSchemaCmd.AddCommand(kbSchemaTemplatesCmd)
	addKbOutput(kbSchemaTemplatesCmd, kbOutputJSON)
}

// kbSchemaTemplatesOutput is what `kb schema templates` prints: only the
// default schema out of GET /api/kb/templates (decision 106).
type kbSchemaTemplatesOutput struct {
	Schema string `json:"schema"`
}

func runKbSchemaTemplates(cmd *cobra.Command, _ []string) error {
	return kbCall(cmd, func(ctx context.Context, client *cli.APIClient) error {
		var templates struct {
			DefaultSchema string `json:"default_schema"`
		}
		if err := client.GetJSON(ctx, "/api/kb/templates", &templates); err != nil {
			return fmt.Errorf("get knowledge base templates: %w", err)
		}

		out := kbSchemaTemplatesOutput{Schema: templates.DefaultSchema}

		// The table form is the schema text itself: it is one Markdown document.
		return kbOutput(cmd, out, func() {
			text := out.Schema
			if !strings.HasSuffix(text, "\n") {
				text += "\n"
			}
			_, _ = fmt.Fprint(os.Stdout, text)
		})
	})
}
