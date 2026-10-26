package kb

import (
	"strings"
	"testing"
)

func TestBuilderInstructions(t *testing.T) {
	create, err := BuilderInstructions(BuilderInstructionsInput{Mode: BuilderModeCreate, SchemaMode: SchemaModeDefault})
	if err != nil {
		t.Fatalf("create: %+v", err)
	}
	if !strings.Contains(create, "- Mode: create") || !strings.Contains(create, "Schema mode at start: default") {
		t.Errorf("create session header missing:\n%s", create)
	}
	if strings.Contains(create, "marvis kb get ") {
		t.Errorf("create mode must not ask to read a configuration")
	}
	if !strings.HasSuffix(strings.TrimRight(create, "\n"), strings.TrimRight(DefaultSchema, "\n")) {
		t.Errorf("default schema is not appended verbatim")
	}

	config, err := BuilderInstructions(BuilderInstructionsInput{Mode: BuilderModeConfig, Slug: "team", SchemaMode: SchemaModeCustom})
	if err != nil {
		t.Fatalf("config: %+v", err)
	}
	if !strings.Contains(config, "- Read the current configuration with `marvis kb get team` before your first reply.") {
		t.Errorf("config mode must read the configuration first:\n%s", config)
	}
	if !strings.Contains(config, "config = change `team`") {
		t.Errorf("config mode must name the knowledge base")
	}

	// Decision 103: the builder's own instructions never mention quickstart;
	// only the default schema it embeds describes it as an ordinary page.
	instructions := strings.TrimSuffix(strings.TrimRight(create, "\n"), strings.TrimRight(DefaultSchema, "\n"))
	if strings.Contains(strings.ToLower(instructions), "quickstart") {
		t.Errorf("builder instructions mention quickstart")
	}
}

func TestDefaultTemplates(t *testing.T) {
	if !strings.HasPrefix(DefaultSchema, "# Schema\n") || !strings.Contains(DefaultSchema, "## 9. Changing this schema") {
		t.Errorf("default schema is not the full template")
	}
	if strings.Contains(DefaultSchema, "home page") || strings.Contains(DefaultSchema, "never delete or move it") {
		t.Errorf("default schema still treats quickstart as a reserved home page")
	}
	if !strings.HasPrefix(PurposeTemplate, "# Purpose\n") || !strings.Contains(PurposeTemplate, "## Common questions") {
		t.Errorf("purpose template = %q", PurposeTemplate)
	}
}
