package kb

import (
	"strings"
	"unicode/utf8"
)

// Job starters (kb_job.starter): the opener a job was started from. It
// decides the default name, the hidden instruction of the first message and
// the source of the merge request the job submits.
const (
	StarterIngest      = "ingest"
	StarterHealth      = "health"
	StarterMerge       = "merge"
	StarterAnnotations = "annotations"
	StarterNewPage     = "new_page"
	StarterSchedule    = "schedule"
	StarterCustom      = "custom"
)

// Merge request sources (kb_merge_request.source).
const (
	MergeRequestSourceIngest      = "ingest"
	MergeRequestSourceHealth      = "health"
	MergeRequestSourceMerge       = "merge"
	MergeRequestSourceAnnotations = "annotations"
	MergeRequestSourceNewPage     = "new_page"
	MergeRequestSourceRevert      = "revert"
	MergeRequestSourceCustom      = "custom"
)

// Merge request risks (kb_merge_request.risk).
const (
	MergeRequestRiskLow    = "low"
	MergeRequestRiskMedium = "medium"
	MergeRequestRiskHigh   = "high"
)

// customJobNameRunes is how much of the first message names a custom job
// (spec 7.10).
const customJobNameRunes = 20

// starterTitles are the job names a starter gets when the client names none.
// The job page names jobs in the member's language and always sends a name.
var starterTitles = map[string]string{
	StarterIngest:      "Ingest sources",
	StarterHealth:      "Health check",
	StarterMerge:       "Merge duplicate pages",
	StarterAnnotations: "Handle annotations",
	StarterNewPage:     "New page",
	StarterSchedule:    "Schedule a recurring run",
}

var starterSources = map[string]string{
	StarterIngest:      MergeRequestSourceIngest,
	StarterHealth:      MergeRequestSourceHealth,
	StarterMerge:       MergeRequestSourceMerge,
	StarterAnnotations: MergeRequestSourceAnnotations,
	StarterNewPage:     MergeRequestSourceNewPage,
}

var mergeRequestSources = map[string]bool{
	MergeRequestSourceIngest:      true,
	MergeRequestSourceHealth:      true,
	MergeRequestSourceMerge:       true,
	MergeRequestSourceAnnotations: true,
	MergeRequestSourceNewPage:     true,
	MergeRequestSourceRevert:      true,
	MergeRequestSourceCustom:      true,
}

var mergeRequestRisks = map[string]bool{
	MergeRequestRiskLow:    true,
	MergeRequestRiskMedium: true,
	MergeRequestRiskHigh:   true,
}

// IsStarter reports whether s is a known job starter.
func IsStarter(s string) bool {
	_, ok := starterTitles[s]

	return ok || s == StarterCustom
}

// IsMergeRequestSource reports whether s is a known merge request source.
func IsMergeRequestSource(s string) bool {
	return mergeRequestSources[s]
}

// IsMergeRequestRisk reports whether s is a known merge request risk.
func IsMergeRequestRisk(s string) bool {
	return mergeRequestRisks[s]
}

// StarterSource is the merge request source of a job started from starter;
// a schedule job is not meant to change pages, so anything it submits counts
// as custom.
func StarterSource(starter string) string {
	if source, ok := starterSources[starter]; ok {
		return source
	}

	return MergeRequestSourceCustom
}

// DefaultJobName names a job the client did not name: the starter's title,
// or for a custom job the start of the member's first message.
func DefaultJobName(starter, message string) string {
	if title, ok := starterTitles[starter]; ok {
		return title
	}

	line := strings.TrimSpace(message)
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = strings.TrimSpace(line[:i])
	}
	if utf8.RuneCountInString(line) <= customJobNameRunes {
		return line
	}

	return string([]rune(line)[:customJobNameRunes])
}
