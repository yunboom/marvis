package kb

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var updateJobGolden = flag.Bool("update-job-golden", false, "rewrite the job first message snapshots")

const testJobID = "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"

func jobInput(starter string) JobMessageInput {
	return JobMessageInput{
		Name:    "Team KB",
		Slug:    "team",
		JobID:   testJobID,
		Starter: starter,
		JobName: DefaultJobName(starter, "Tidy the payment pages"),
		Message: "Tidy the payment pages",
	}
}

// TestJobFirstMessageSnapshots locks the rendered first message of every
// starter, with and without the context an entry point brings in.
func TestJobFirstMessageSnapshots(t *testing.T) {
	cases := map[string]JobMessageInput{
		"custom":   jobInput(StarterCustom),
		"ingest":   jobInput(StarterIngest),
		"schedule": jobInput(StarterSchedule),
		"health":   jobInput(StarterHealth),
		"merge":    jobInput(StarterMerge),
		"annotations": func() JobMessageInput {
			in := jobInput(StarterAnnotations)
			in.Annotations = []JobAnnotation{
				{ID: "a1", Where: "`team:/payment/callback#^b8Xz`", Quote: "By order id.", Body: "It is the channel transaction id now."},
				{ID: "a2", Where: "knowledge base", Body: "Add an on-call page."},
			}

			return in
		}(),
		"annotations_none": jobInput(StarterAnnotations),
		"ingest_sources": func() JobMessageInput {
			in := jobInput(StarterIngest)
			in.Sources = []JobSource{{URI: "raw://sources/spec-v3.pdf", Title: "spec-v3.pdf"}}

			return in
		}(),
		"health_page": func() JobMessageInput {
			in := jobInput(StarterHealth)
			in.Page = "Callback (`team:/payment/callback`)"

			return in
		}(),
		"new_page": func() JobMessageInput {
			in := jobInput(StarterNewPage)
			in.ParentTitle = "Payment"
			in.ParentPath = "team:/payment"

			return in
		}(),
	}

	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := JobFirstMessage(in)
			if err != nil {
				t.Fatalf("render: %+v", err)
			}

			path := filepath.Join("testdata", "job_message", name+".golden")
			if *updateJobGolden {
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read snapshot (run with -update-job-golden): %v", err)
			}
			if got != string(want) {
				t.Errorf("first message differs from %s:\n%s", path, got)
			}

			if !strings.Contains(got, "`marvis kb draft create team --job "+testJobID+"`") {
				t.Error("first message does not carry the job id in the draft command")
			}
			if !strings.HasSuffix(got, MemberMessageMarker+in.Message) {
				t.Error("first message does not end with the member's message")
			}
		})
	}
}

func TestDefaultJobName(t *testing.T) {
	if got := DefaultJobName(StarterAnnotations, "anything"); got != "Handle annotations" {
		t.Errorf("annotations name = %q", got)
	}
	if got := DefaultJobName(StarterCustom, "  把支付回调的去重说明改成按渠道交易号去重并补上生效时间\n第二行"); got != "把支付回调的去重说明改成按渠道交易号去重" {
		t.Errorf("custom name = %q", got)
	}
	if got := DefaultJobName(StarterCustom, "short"); got != "short" {
		t.Errorf("short custom name = %q", got)
	}
}

func TestStarterSource(t *testing.T) {
	for starter, want := range map[string]string{
		StarterIngest:   MergeRequestSourceIngest,
		StarterNewPage:  MergeRequestSourceNewPage,
		StarterSchedule: MergeRequestSourceCustom,
		StarterCustom:   MergeRequestSourceCustom,
	} {
		if got := StarterSource(starter); got != want {
			t.Errorf("StarterSource(%s) = %s, want %s", starter, got, want)
		}
	}
	if !IsStarter(StarterCustom) || !IsStarter(StarterSchedule) || IsStarter("revert") {
		t.Error("IsStarter")
	}
}
