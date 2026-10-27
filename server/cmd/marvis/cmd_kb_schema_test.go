package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestKbSchemaTemplatesPrintsOnlySchema(t *testing.T) {
	seen := newKbTestServer(t, http.StatusOK, map[string]any{
		"default_schema":   "# Schema\n\nThis file tells agents how pages are laid out.\n",
		"purpose_template": "# Purpose\n",
	})

	out, err := runKbTestCmd(t, kbSchemaTemplatesCmd)
	if err != nil {
		t.Fatalf("schema templates: %v", err)
	}
	if req := (*seen)[0]; req.Method != http.MethodGet || req.Path != "/api/kb/templates" {
		t.Errorf("request = %+v", req)
	}

	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	if len(got) != 1 || got["schema"] != "# Schema\n\nThis file tells agents how pages are laid out.\n" {
		t.Errorf("output = %v, want only the schema", got)
	}
}

func TestKbSchemaTemplatesTablePrintsSchemaText(t *testing.T) {
	newKbTestServer(t, http.StatusOK, map[string]any{"default_schema": "# Schema\n\nBody", "purpose_template": "# Purpose\n"})

	out, err := runKbTestCmd(t, kbSchemaTemplatesCmd, "--output", "table")
	if err != nil {
		t.Fatalf("schema templates: %v", err)
	}
	if out != "# Schema\n\nBody\n" {
		t.Errorf("table output = %q, want the schema text", out)
	}
}

func TestKbSchemaTemplatesRejectsArgs(t *testing.T) {
	if err := kbSchemaTemplatesCmd.Args(kbSchemaTemplatesCmd, []string{"team"}); err == nil {
		t.Error("schema templates accepted an argument")
	}
}
