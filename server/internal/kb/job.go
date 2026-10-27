package kb

import (
	_ "embed"
	"strings"
	"text/template"
	"unicode/utf8"

	"github.com/pkg/errors"
)

// Job starters (kb_job.starter): the opener a job was started from. It
// decides the default name, the starter section of the first message and the
// source of the merge request the job submits.
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

// MemberMessageMarker separates the server-written part of a job's first
// message from what the member typed; the job page shows only the latter.
const MemberMessageMarker = "\nMember's message:\n"

// starterTitles are the job names a starter gets when the client names none,
// and the "Job:" line of the first message. English because the first
// message is read by the agent; the job page names jobs in the member's
// language and always sends a name.
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

//go:embed templates/job_message.md.tmpl
var jobMessageSource string

var jobMessageTemplate = template.Must(template.New("kb-job").Parse(jobMessageSource))

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

// JobSource is a source brought into an ingest job.
type JobSource struct {
	URI   string
	Title string
}

// JobAnnotation is an annotation brought into an annotations job.
type JobAnnotation struct {
	ID string
	// Where is the page path (with #^block for a sentence) or "knowledge
	// base" for an annotation on the whole knowledge base.
	Where string
	Quote string
	Body  string
}

// JobMessageInput fills a job's first message (spec 08.4) and its starter
// section (spec 08.5).
type JobMessageInput struct {
	Name    string
	Slug    string
	JobID   string
	Starter string
	// JobName names the job; it is the "Job:" line of a custom job.
	JobName string
	Message string

	Sources     []JobSource
	Page        string
	Pages       string
	Annotations []JobAnnotation
	ParentTitle string
	ParentPath  string
}

// JobFirstMessage renders the first message of a job: the general part with
// the job id, the starter section and the member's message.
func JobFirstMessage(in JobMessageInput) (string, error) {
	var section strings.Builder
	if in.Starter != StarterCustom {
		if err := jobMessageTemplate.ExecuteTemplate(&section, in.Starter, in); err != nil {
			return "", errors.Wrapf(err, "render job starter section starter=%s job_id=%s", in.Starter, in.JobID)
		}
	}

	title := starterTitles[in.Starter]
	if title == "" {
		title = in.JobName
	}

	var out strings.Builder
	err := jobMessageTemplate.ExecuteTemplate(&out, "first", map[string]any{
		"Name":                in.Name,
		"Slug":                in.Slug,
		"StarterTitle":        title,
		"JobID":               in.JobID,
		"StarterInstructions": section.String(),
		"Message":             in.Message,
	})
	if err != nil {
		return "", errors.Wrapf(err, "render job first message job_id=%s", in.JobID)
	}

	return out.String(), nil
}
