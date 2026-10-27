package kb

import (
	_ "embed"
	"strings"
	"text/template"

	"github.com/pkg/errors"

	"github.com/yunboom/marvis/server/internal/util"
)

// Why a review comment started an agent (kb_mr_comment.triggered).
const (
	// TriggerReasonAuthor is the merge request's author agent picking up a
	// comment nobody was named in.
	TriggerReasonAuthor = "author"
	// TriggerReasonMention is an agent the comment @-mentions.
	TriggerReasonMention = "mention"
)

// Mention types a review comment's triggers look at (util.Mention.Type).
const (
	mentionTypeAgent  = "agent"
	mentionTypeMember = "member"
)

// Actor types of merge request authors and commenters.
const (
	// ActorMember is a workspace member.
	ActorMember = "member"
	// ActorAgent is an agent acting through its task token.
	ActorAgent = "agent"
)

//go:embed templates/review_comment.md.tmpl
var reviewCommentSource string

var reviewCommentTemplate = template.Must(template.New("kb-review-comment").Parse(reviewCommentSource))

// ReviewTriggerInput is what decides which agents a review comment starts.
type ReviewTriggerInput struct {
	Body string
	// CommenterType and CommenterID are who wrote the comment.
	CommenterType string
	CommenterID   string
	// AuthorAgentID is the agent behind the merge request: its author when an
	// agent wrote it, else the agent of the job it came from; empty when no
	// agent stands behind it.
	AuthorAgentID string
}

// ReviewTrigger is one agent a review comment starts.
type ReviewTrigger struct {
	AgentID string
	Reason  string
}

// ReviewCommentTriggers picks the agents a review comment starts, following
// the issue comment rules (spec 7.9): agents named with @ win; a comment
// that names members or @all starts nobody; otherwise a member's comment
// goes to the author agent. An agent's own comment only starts the agents it
// names, so an agent replying on the request does not wake itself.
func ReviewCommentTriggers(in ReviewTriggerInput) []ReviewTrigger {
	mentions := util.ParseMentions(in.Body)

	named := make([]ReviewTrigger, 0)
	for _, m := range mentions {
		if m.Type != mentionTypeAgent {
			continue
		}
		if in.CommenterType == ActorAgent && m.ID == in.CommenterID {
			continue
		}
		named = append(named, ReviewTrigger{AgentID: m.ID, Reason: TriggerReasonMention})
	}
	if len(named) > 0 {
		return named
	}

	if util.HasMentionAll(mentions) {
		return nil
	}
	for _, m := range mentions {
		if m.Type == mentionTypeMember {
			return nil
		}
	}

	if in.CommenterType != ActorMember || in.AuthorAgentID == "" {
		return nil
	}

	return []ReviewTrigger{{AgentID: in.AuthorAgentID, Reason: TriggerReasonAuthor}}
}

// ReviewCommentInput fills the review comment hand-off message (spec 8.6).
type ReviewCommentInput struct {
	Number    int
	Title     string
	Author    string
	QuotePage string
	QuoteText string
	Body      string
	DraftID   string
	CommentID string
}

// ReviewCommentMessage renders the spec 8.6 message an agent receives for a
// review comment: into the job's chat when the request came from a job,
// otherwise as the instructions of the task it is given.
func ReviewCommentMessage(in ReviewCommentInput) (string, error) {
	var b strings.Builder
	data := struct {
		ReviewCommentInput
		Quote bool
	}{ReviewCommentInput: in, Quote: in.QuoteText != ""}
	if err := reviewCommentTemplate.Execute(&b, data); err != nil {
		return "", errors.Wrapf(err, "render review comment comment_id=%s", in.CommentID)
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
