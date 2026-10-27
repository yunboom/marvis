package kb

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var updateBuilderGolden = flag.Bool("update-builder-golden", false, "rewrite the builder instructions snapshots")

// platformKnowledgeBasesReference is the platform skill reference the builder
// instructions point at for how to create and configure a knowledge base.
const platformKnowledgeBasesReference = "../service/builtin_skills/marvis-platform/references/knowledge-bases.md"

// TestBuilderInstructionsSnapshots locks the rendered instructions of both
// builder modes.
func TestBuilderInstructionsSnapshots(t *testing.T) {
	cases := map[string]BuilderInstructionsInput{
		"create_default": {Mode: BuilderModeCreate, SchemaMode: SchemaModeDefault},
		"config_custom":  {Mode: BuilderModeConfig, Slug: "team", SchemaMode: SchemaModeCustom},
	}

	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := BuilderInstructions(in)
			if err != nil {
				t.Fatalf("render: %+v", err)
			}

			path := filepath.Join("testdata", "builder", name+".golden")
			if *updateBuilderGolden {
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read snapshot (run with -update-builder-golden): %v", err)
			}
			if got != string(want) {
				t.Errorf("builder instructions differ from %s:\n%s", path, got)
			}
		})
	}
}

func TestBuilderInstructionsByMode(t *testing.T) {
	create, err := BuilderInstructions(BuilderInstructionsInput{Mode: BuilderModeCreate, SchemaMode: SchemaModeDefault})
	if err != nil {
		t.Fatalf("create: %+v", err)
	}
	if strings.Contains(create, "marvis kb get ") {
		t.Errorf("create mode must not ask to read a configuration")
	}

	config, err := BuilderInstructions(BuilderInstructionsInput{Mode: BuilderModeConfig, Slug: "team", SchemaMode: SchemaModeCustom})
	if err != nil {
		t.Fatalf("config: %+v", err)
	}
	if !strings.Contains(config, "- Read the current configuration with `marvis kb get team` before your first reply.") {
		t.Errorf("config mode must read the configuration first:\n%s", config)
	}

	// Decision 106: the default schema is fetched with a command, not embedded.
	if strings.Contains(create, "# Schema\n") || !strings.Contains(create, "`marvis kb schema templates`") {
		t.Errorf("builder instructions must point at `marvis kb schema templates` instead of embedding the default schema")
	}
}

// TestBuilderInstructionsCiteAnExistingSkillSection guards the section name
// the builder instructions defer to: renaming the heading in the platform
// skill would leave the builder pointing at nothing.
func TestBuilderInstructionsCiteAnExistingSkillSection(t *testing.T) {
	reference, err := os.ReadFile(platformKnowledgeBasesReference)
	if err != nil {
		t.Fatalf("read platform skill reference: %v", err)
	}

	const section = "Creating and configuring a knowledge base"
	if !strings.Contains(builderInstructionsSource, `"`+section+`"`) {
		t.Fatalf("builder instructions no longer cite %q", section)
	}
	if !strings.Contains(string(reference), "\n## "+section+"\n") {
		t.Errorf("%s has no %q section", platformKnowledgeBasesReference, section)
	}
}

// TestPromptTemplatesAvoidRetiredTerms keeps retired names out of every
// knowledge base prompt. Decision 103: only the default schema may mention
// quickstart, as an ordinary suggested page.
func TestPromptTemplatesAvoidRetiredTerms(t *testing.T) {
	sources := map[string]string{
		"builder instructions": builderInstructionsSource,
		"instructions":         instructionsSource,
		"purpose template":     PurposeTemplate,
	}
	// Decision 107: review comments no longer start agent runs.
	retired := []string{"quickstart", "kb job link-draft", "marvis kb templates", "DefaultSchema", "starts a new run", "new run for you"}

	for name, source := range sources {
		for _, term := range retired {
			if strings.Contains(strings.ToLower(source), strings.ToLower(term)) {
				t.Errorf("%s mentions %q", name, term)
			}
		}
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
