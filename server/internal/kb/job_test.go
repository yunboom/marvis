package kb

import (
	"testing"
)

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
