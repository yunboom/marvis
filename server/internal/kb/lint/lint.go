// Package lint holds the knowledge base format checks (spec 4.7) shared by
// the draft endpoints and kb draft check. Errors block a merge request;
// warnings are advice.
package lint

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/yunboom/marvis/server/internal/kb"
)

// Severities.
const (
	// SeverityError blocks submitting the draft.
	SeverityError = "error"
	// SeverityWarning is shown but does not block.
	SeverityWarning = "warning"
)

// Rule codes.
const (
	CodeMissingType            = "missing_type"
	CodeMissingTitle           = "missing_title"
	CodeMissingDescription     = "missing_description"
	CodeUndefinedFootnote      = "undefined_footnote"
	CodeClaimWithoutEvidence   = "claim_without_evidence"
	CodeInvalidEvidenceURI     = "invalid_evidence_uri"
	CodeDuplicateSlug          = "duplicate_slug"
	CodeUnresolvedConflict     = "unresolved_conflict"
	CodeMissingEvidenceVersion = "missing_evidence_version"
	CodeUnresolvedLink         = "unresolved_link"
	CodeOrphanPage             = "orphan_page"
	CodeIsolatedPage           = "isolated_page"
)

// minRelatedPages is how many other pages a page with content should link to.
const minRelatedPages = 2

// Finding is one check result for a page.
type Finding struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	PageID   string `json:"page_id"`
	Path     string `json:"path"`
	// BlockID points at the block the finding is about, when there is one.
	BlockID string `json:"block_id,omitempty"`
	Message string `json:"message"`
}

// Page is what the checks need to know about one page as the draft has it.
type Page struct {
	ID          string
	Path        string
	Frontmatter map[string]any
	// Blocks hold links in the path form (/a/b.md) or as kb:// to pages
	// that exist.
	Blocks []kb.Block
	Claims []kb.Claim
	// Conflicts are the unresolved kb draft sync conflicts of the page.
	Conflicts []kb.Conflict
	// DuplicateSlug reports that a sibling has the same path segment.
	DuplicateSlug bool
	// UnresolvedLinks are the link paths no page answers to.
	UnresolvedLinks []string
	// LinkedPages is the number of distinct other pages the page links to,
	// written or not yet written.
	LinkedPages int
	// Inbound is the number of other pages linking to this one.
	Inbound int
}

// footnoteRefRe finds footnote references [^id]; definitions ([^id]:) are
// filtered out by the caller.
var footnoteRefRe = regexp.MustCompile(`\[\^([^\]\s]+)\]`)

// allowedEvidenceKinds are the evidence uri schemes spec 4.3 allows.
var allowedEvidenceKinds = map[string]bool{
	kb.SourceKindTask: true,
	kb.SourceKindChat: true,
	kb.SourceKindPR:   true,
	kb.SourceKindRepo: true,
	kb.SourceKindRaw:  true,
	kb.SourceKindWeb:  true,
}

// versionedEvidenceKinds need a version to be re-checked later.
var versionedEvidenceKinds = map[string]bool{
	kb.SourceKindRepo: true,
	kb.SourceKindPR:   true,
}

// Check runs every rule on one page and returns its findings, errors first.
func Check(p Page) []Finding {
	out := make([]Finding, 0)
	add := func(code, severity, blockID, message string) {
		out = append(out, Finding{Code: code, Severity: severity, PageID: p.ID, Path: p.Path, BlockID: blockID, Message: message})
	}

	for _, req := range []struct{ key, code string }{
		{kb.MetaType, CodeMissingType},
		{kb.MetaTitle, CodeMissingTitle},
		{kb.MetaDescription, CodeMissingDescription},
	} {
		if s, _ := p.Frontmatter[req.key].(string); strings.TrimSpace(s) == "" {
			add(req.code, SeverityError, "", fmt.Sprintf("the page header has no %s", req.key))
		}
	}

	checkClaims(p, add)

	if p.DuplicateSlug {
		add(CodeDuplicateSlug, SeverityError, "", "another page under the same parent has this path segment")
	}

	checkConflicts(p, add)

	for _, path := range p.UnresolvedLinks {
		add(CodeUnresolvedLink, SeverityWarning, "", fmt.Sprintf("%s is not written yet", path))
	}
	if p.Inbound == 0 {
		add(CodeOrphanPage, SeverityWarning, "", "no other page links to this page")
	}
	if len(p.Blocks) > 0 && p.LinkedPages < minRelatedPages {
		add(CodeIsolatedPage, SeverityWarning, "", fmt.Sprintf("the page links to %d related pages, fewer than %d", p.LinkedPages, minRelatedPages))
	}

	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Severity == SeverityError && out[j].Severity != SeverityError
	})

	return out
}

func checkClaims(p Page, add func(code, severity, blockID, message string)) {
	blockIDs := make(map[string]struct{}, len(p.Blocks))
	for _, block := range p.Blocks {
		blockIDs[block.ID] = struct{}{}
	}

	sourcesByBlock := make(map[string]map[string]struct{})
	for _, claim := range p.Claims {
		_, onPage := blockIDs[claim.BlockID]
		if len(claim.Evidence) == 0 || !onPage {
			add(CodeClaimWithoutEvidence, SeverityError, claim.BlockID,
				fmt.Sprintf("claim %s has no evidence or points at a block not on the page", claim.Key))
		}

		for _, ev := range claim.Evidence {
			kind := kb.SourceKind(ev.URI)
			if !allowedEvidenceKinds[kind] {
				add(CodeInvalidEvidenceURI, SeverityError, claim.BlockID,
					fmt.Sprintf("claim %s cites %q, which is not an allowed evidence uri", claim.Key, ev.URI))
			}
			if versionedEvidenceKinds[kind] && strings.TrimSpace(ev.Version) == "" {
				add(CodeMissingEvidenceVersion, SeverityWarning, claim.BlockID,
					fmt.Sprintf("claim %s cites %s without a version", claim.Key, ev.URI))
			}
			if sourcesByBlock[claim.BlockID] == nil {
				sourcesByBlock[claim.BlockID] = make(map[string]struct{})
			}
			sourcesByBlock[claim.BlockID][ev.Source] = struct{}{}
		}
	}

	for _, block := range p.Blocks {
		for _, id := range FootnoteRefs(block.Content) {
			if _, ok := sourcesByBlock[block.ID][id]; !ok {
				add(CodeUndefinedFootnote, SeverityError, block.ID,
					fmt.Sprintf("footnote [^%s] is not backed by a claim on this block", id))
			}
		}
	}
}

func checkConflicts(p Page, add func(code, severity, blockID, message string)) {
	reported := make(map[string]bool)
	for _, c := range p.Conflicts {
		switch c.Kind {
		case kb.ConflictBlock:
			reported[c.BlockID] = true
			add(CodeUnresolvedConflict, SeverityError, c.BlockID, fmt.Sprintf("block %s still has a conflict with the mainline", c.BlockID))
		case kb.ConflictMeta:
			add(CodeUnresolvedConflict, SeverityError, "", fmt.Sprintf("header key %s conflicts with the mainline", c.Key))
		case kb.ConflictMove:
			add(CodeUnresolvedConflict, SeverityError, "", "the page placement conflicts with the mainline")
		default:
			add(CodeUnresolvedConflict, SeverityError, "", "the mainline deleted or changed this page as well")
		}
	}

	for _, block := range p.Blocks {
		if !reported[block.ID] && kb.HasConflictMarkers(block.Content) {
			add(CodeUnresolvedConflict, SeverityError, block.ID, fmt.Sprintf("block %s still contains conflict markers", block.ID))
		}
	}
}

// FootnoteRefs lists the footnote ids a block references, in order and
// without duplicates; footnote definitions ([^id]: text) are not references.
func FootnoteRefs(content string) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0)
	for _, m := range footnoteRefRe.FindAllStringSubmatchIndex(content, -1) {
		end := m[1]
		if end < len(content) && content[end] == ':' {
			continue
		}
		id := content[m[2]:m[3]]
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}

	return out
}

// HasErrors reports whether any finding blocks submitting.
func HasErrors(findings []Finding) bool {
	for _, f := range findings {
		if f.Severity == SeverityError {
			return true
		}
	}

	return false
}
