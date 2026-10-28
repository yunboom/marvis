package kb

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var updateBuilderGolden = flag.Bool("update-builder-golden", false, "rewrite the builder instructions snapshots")

// platformSkillDir is the platform skill the builder instructions defer to.
const platformSkillDir = "../service/builtin_skills/marvis-platform/"

// builderSkillReference is the reference file the builder instructions cite,
// relative to the skill.
const builderSkillReference = "references/knowledge-bases/kb-create-update.md"

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

// TestBuilderInstructionsCiteAnExistingSkillReference guards the reference the
// builder instructions defer to: moving or renaming it in the platform skill
// would leave the builder pointing at nothing.
func TestBuilderInstructionsCiteAnExistingSkillReference(t *testing.T) {
	if !strings.Contains(builderInstructionsSource, "`"+builderSkillReference+"`") {
		t.Fatalf("builder instructions no longer cite %q", builderSkillReference)
	}

	reference, err := os.ReadFile(platformSkillDir + builderSkillReference)
	if err != nil {
		t.Fatalf("read platform skill reference: %v", err)
	}
	if !strings.Contains(string(reference), "# kb create / kb update") {
		t.Errorf("%s is not the create and configure reference", builderSkillReference)
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
