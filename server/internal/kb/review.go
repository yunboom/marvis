package kb

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
