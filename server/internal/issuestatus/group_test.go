package issuestatus

import (
	"context"
	"testing"
)

func TestGroupRulesFollowCategory(t *testing.T) {
	cases := []struct {
		key, category, group string
		valid                bool
	}{
		{"triage", CategoryUnstarted, GroupNotStarted, true},
		{"triage", CategoryUnstarted, GroupWorking, false},
		{"qa", CategoryStarted, GroupWorking, true},
		{"qa", CategoryStarted, GroupNeedsAttention, true},
		{"qa", CategoryStarted, GroupEnded, false},
		{"shipped", CategoryDone, GroupEnded, true},
		{"shipped", CategoryDone, GroupNeedsAttention, false},
		{"wont_fix", CategoryClosed, GroupEnded, true},
		{"unknown", "not_a_category", GroupEnded, false},
	}
	for _, tc := range cases {
		if got := ValidGroup(tc.category, tc.group); got != tc.valid {
			t.Errorf("ValidGroup(%q, %q) = %v, want %v", tc.category, tc.group, got, tc.valid)
		}
	}

	defaults := map[string]string{
		CategoryUnstarted: GroupNotStarted,
		CategoryStarted:   GroupWorking,
		CategoryDone:      GroupEnded,
		CategoryClosed:    GroupEnded,
	}
	for category, want := range defaults {
		if got := DefaultGroup("custom", category); got != want {
			t.Errorf("DefaultGroup(custom, %q) = %q, want %q", category, got, want)
		}
	}
}

func TestBuiltInGroupsAreFixed(t *testing.T) {
	want := map[string]string{
		Backlog:    GroupNotStarted,
		Todo:       GroupNotStarted,
		InProgress: GroupWorking,
		InReview:   GroupNeedsAttention,
		Blocked:    GroupNeedsAttention,
		Done:       GroupEnded,
		Cancelled:  GroupEnded,
	}
	for _, key := range Canonical() {
		if got := BuiltInGroup(key); got != want[key] {
			t.Errorf("BuiltInGroup(%q) = %q, want %q", key, got, want[key])
		}
	}
	if got := BuiltInGroup("qa"); got != "" {
		t.Errorf("BuiltInGroup(custom) = %q, want empty", got)
	}
}

func TestResolverGroup(t *testing.T) {
	waiting := custom("waiting_customer", CategoryStarted)
	waiting.StatusGroup = GroupNeedsAttention
	q := newFakeQuerier(waiting)
	r := NewResolver(testWorkspace)

	if got := r.Group(context.Background(), q, InReview); got != GroupNeedsAttention {
		t.Errorf("Group(in_review) = %q, want %q", got, GroupNeedsAttention)
	}
	if q.lookups != 0 {
		t.Errorf("built-in group read the catalog %d times, want 0", q.lookups)
	}
	if got := r.Group(context.Background(), q, "waiting_customer"); got != GroupNeedsAttention {
		t.Errorf("Group(waiting_customer) = %q, want %q", got, GroupNeedsAttention)
	}
	if got := r.Group(context.Background(), q, "missing"); got != "" {
		t.Errorf("Group(missing) = %q, want empty", got)
	}
}

func TestCategoryNameAndGroup(t *testing.T) {
	waiting := custom("waiting_customer", CategoryStarted)
	waiting.Name = "待客户确认"
	waiting.StatusGroup = GroupNeedsAttention
	q := newFakeQuerier(waiting)

	category, name, group := CategoryNameAndGroup(context.Background(), q, testWorkspace, "waiting_customer")
	if category != CategoryStarted || name != "待客户确认" || group != GroupNeedsAttention {
		t.Errorf("got (%q, %q, %q), want (%q, %q, %q)", category, name, group, CategoryStarted, "待客户确认", GroupNeedsAttention)
	}

	category, name, group = CategoryNameAndGroup(context.Background(), q, testWorkspace, Blocked)
	if category != CategoryStarted || name != "" || group != GroupNeedsAttention {
		t.Errorf("built-in got (%q, %q, %q)", category, name, group)
	}
}
