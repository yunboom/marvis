package kb

import (
	_ "embed"
	"strings"
	"text/template"

	"github.com/pkg/errors"
)

// Builder conversation modes (kb_builder_session.mode).
const (
	// BuilderModeCreate drafts a new knowledge base.
	BuilderModeCreate = "create"
	// BuilderModeConfig changes an existing knowledge base.
	BuilderModeConfig = "config"
)

// BuilderSystemKeyPrefix marks the hidden carrier agent behind a knowledge
// base builder conversation; the suffix is the flow id. The agent builder's
// carriers use "agent_builder:".
const BuilderSystemKeyPrefix = "kb_builder:"

// The templates are Markdown with fenced code blocks, which a Go raw string
// cannot hold, so they are embedded from files instead of inlined.
var (
	// DefaultSchema is the built-in schema written into kb_base.schema when a
	// knowledge base uses the default schema mode.
	//
	//go:embed templates/default_schema.md
	DefaultSchema string

	// PurposeTemplate is the outline the builder drafts a purpose from.
	//
	//go:embed templates/purpose.md
	PurposeTemplate string

	//go:embed templates/builder_instructions.md.tmpl
	builderInstructionsSource string
)

var builderInstructionsTemplate = template.Must(template.New("kb-builder").Parse(builderInstructionsSource))

// BuilderInstructionsInput fills the builder instructions for one session.
type BuilderInstructionsInput struct {
	Mode string
	// Slug is the configured knowledge base; empty when creating.
	Slug       string
	SchemaMode string
}

// IsBuilderMode reports whether mode is a known builder conversation mode.
func IsBuilderMode(mode string) bool {
	return mode == BuilderModeCreate || mode == BuilderModeConfig
}

// IsSchemaMode reports whether mode is a known schema mode.
func IsSchemaMode(mode string) bool {
	return mode == SchemaModeDefault || mode == SchemaModeCustom
}

// BuilderInstructions renders the hidden builder agent's instructions.
func BuilderInstructions(in BuilderInstructionsInput) (string, error) {
	var out strings.Builder
	if err := builderInstructionsTemplate.Execute(&out, in); err != nil {
		return "", errors.Wrapf(err, "render builder instructions mode=%s slug=%q", in.Mode, in.Slug)
	}

	return out.String(), nil
}
