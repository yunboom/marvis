package kb

import (
	_ "embed"
	"regexp"
	"strings"
	"text/template"

	"github.com/pkg/errors"
)

// Actor types of merge request authors and commenters.
const (
	// ActorMember is a workspace member.
	ActorMember = "member"
	// ActorAgent is an agent acting through its task token.
	ActorAgent = "agent"
)

// Review states (kb_mr_review.state).
const (
	// ReviewStatePending is a review still being written; its comments show
	// only to the reviewer.
	ReviewStatePending = "pending"
	// ReviewStateSubmitted is a published review.
	ReviewStateSubmitted = "submitted"
)

//go:embed templates/review_handoff.md.tmpl
var reviewHandoffSource string

var reviewHandoffTemplate = template.Must(template.New("kb-review-handoff").Parse(reviewHandoffSource))

// ReviewHandoffSummary is one review summary handed to the agent.
type ReviewHandoffSummary struct {
	Reviewer string
	Text     string
}

// ReviewHandoffComment is one review comment handed to the agent.
type ReviewHandoffComment struct {
	ID        string
	Author    string
	QuotePage string
	QuoteText string
	Body      string
}

// ReviewHandoffInput fills the message a member sends into the job's chat to
// have its agent address the review feedback (decision 107).
type ReviewHandoffInput struct {
	Number    int
	Title     string
	DraftID   string
	Summaries []ReviewHandoffSummary
	Comments  []ReviewHandoffComment
}

// ReviewHandoffLead matches the lead of every review hand-off message. The
// message goes to the agent in full; the job page keys on the same pattern
// (packages/views/kb/jobs/kb-job-state.ts) to show a short line in the
// member's language in its place.
var ReviewHandoffLead = regexp.MustCompile(`(?s)^Change request #(\d+) \(.*?\) has review feedback to resolve\.`)

// ReviewHandoffMessage renders the review feedback hand-off message.
func ReviewHandoffMessage(in ReviewHandoffInput) (string, error) {
	var b strings.Builder
	if err := reviewHandoffTemplate.Execute(&b, in); err != nil {
		return "", errors.Wrapf(err, "render review handoff number=%d", in.Number)
	}

	return strings.TrimRight(b.String(), "\n"), nil
}

// RevertPage plans one page of a revert (spec 6.3): the page goes back to
// before, the revision the merge request replaced, three-way merged over
// what the mainline has now with after, the revision the request wrote, as
// the base. When the mainline still has after, the revert is just before.
// Later changes to the same blocks conflict.
func RevertPage(before, after, current PageVersion, currentIsAfter bool) MergeResult {
	if currentIsAfter {
		return MergeResult{Page: before, Conflicts: []Conflict{}}
	}

	return MergePage(after, current, before)
}
