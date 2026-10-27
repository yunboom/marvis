// Package kb holds the knowledge base domain: the block model of page bodies,
// link parsing, search text and mainline page writes. HTTP handlers live in
// internal/handler/kb_*.go.
package kb

// Schema modes of a knowledge base (kb_base.schema_mode).
const (
	// SchemaModeDefault uses the built-in schema template written at creation.
	SchemaModeDefault = "default"
	// SchemaModeCustom uses a schema drafted for this knowledge base.
	SchemaModeCustom = "custom"
)

// Annotation statuses (kb_annotation.status).
const (
	// AnnotationStatusPending is an annotation nobody has handled yet.
	AnnotationStatusPending = "pending"
	// AnnotationStatusProcessing is an annotation a job is working on.
	AnnotationStatusProcessing = "processing"
	// AnnotationStatusResolved is an annotation a merge resolved.
	AnnotationStatusResolved = "resolved"
	// AnnotationStatusDismissed is an annotation closed without a change.
	AnnotationStatusDismissed = "dismissed"
)

// Merge request statuses (kb_merge_request.status).
const (
	// MergeRequestStatusOpen is waiting for review.
	MergeRequestStatusOpen = "open"
	// MergeRequestStatusChangesRequested has a submitted review waiting on
	// its owner; it cannot merge until the owner asks for review again.
	MergeRequestStatusChangesRequested = "changes_requested"
	// MergeRequestStatusMerged is applied to the mainline.
	MergeRequestStatusMerged = "merged"
	// MergeRequestStatusClosed is closed without merging.
	MergeRequestStatusClosed = "closed"
)

// Draft statuses (kb_draft.status).
const (
	// DraftStatusOpen accepts writes.
	DraftStatusOpen = "open"
	// DraftStatusSubmitted has an open merge request.
	DraftStatusSubmitted = "submitted"
	// DraftStatusMerged was merged into the mainline.
	DraftStatusMerged = "merged"
	// DraftStatusDiscarded was abandoned.
	DraftStatusDiscarded = "discarded"
)
