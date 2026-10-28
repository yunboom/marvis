package kb

import (
	_ "embed"
	"strings"
	"text/template"

	"github.com/pkg/errors"
)

// reviewHandoffInstruction names the hand-off's template in instructions.md.tmpl.
const reviewHandoffInstruction = "review_handoff"

//go:embed templates/instructions.md.tmpl
var instructionsSource string

var instructionsTemplate = template.Must(template.New("kb-instructions").Parse(instructionsSource))

// starterInstructions are the starters whose request is a multi-step process
// an agent gets wrong from the command reference alone; they send the process
// as a hidden instruction next to the member's visible request. The other
// starters send the request alone.
var starterInstructions = map[string]bool{
	StarterIngest:   true,
	StarterHealth:   true,
	StarterMerge:    true,
	StarterSchedule: true,
}

// JobInstruction is the hidden instruction that goes with a job's first
// message, or "" when the starter needs none.
func JobInstruction(starter string) (string, error) {
	if !starterInstructions[starter] {
		return "", nil
	}

	return renderInstruction(starter, nil)
}

// ReviewHandoffInstruction is the hidden instruction that goes with a review
// hand-off: how to resolve the feedback on change request number.
func ReviewHandoffInstruction(number int) (string, error) {
	return renderInstruction(reviewHandoffInstruction, number)
}

func renderInstruction(name string, data any) (string, error) {
	var b strings.Builder
	if err := instructionsTemplate.ExecuteTemplate(&b, name, data); err != nil {
		return "", errors.Wrapf(err, "render instruction name=%s", name)
	}

	return b.String(), nil
}
