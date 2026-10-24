package knowledge

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEstimateTokens(t *testing.T) {
	t.Parallel()

	cases := []struct {
		text string
		want int
	}{
		{"", 0},
		{"abcd", 1},
		{"abcde", 2},
		{"退款", 2},
		{"退款 ok", 3},
	}
	for _, tc := range cases {
		if got := EstimateTokens(tc.text); got != tc.want {
			t.Errorf("EstimateTokens(%q) = %d, want %d", tc.text, got, tc.want)
		}
	}
}

func TestTrimSourceText(t *testing.T) {
	t.Parallel()

	short := strings.Repeat("字", SourceItemMaxRunes)
	if TrimSourceText(short) != short {
		t.Fatal("text at the limit must stay unchanged")
	}
	long := TrimSourceText(strings.Repeat("字", SourceItemMaxRunes+10))
	if utf8.RuneCountInString(long) != SourceItemMaxRunes+1 || !strings.HasSuffix(long, "…") {
		t.Fatalf("long text trimmed to %d runes", utf8.RuneCountInString(long))
	}
}

func TestPaginateSources(t *testing.T) {
	t.Parallel()

	// 每条成本 = 40 开销 + 60 个汉字 = 100 token；窗口 1000 时每页预算 600，正好 6 条。
	item := SourceItem{Kind: SourceItemComment, Text: strings.Repeat("字", 60)}
	items := func(n int) []SourceItem {
		out := make([]SourceItem, n)
		for i := range out {
			out[i] = item
		}
		return out
	}

	cases := []struct {
		name          string
		items         []SourceItem
		window        int
		wantPageSizes []int
		wantRemaining int
	}{
		{name: "empty", items: nil, window: 1000},
		{name: "fits one page", items: items(6), window: 1000, wantPageSizes: []int{6}},
		{name: "spills to second page", items: items(7), window: 1000, wantPageSizes: []int{6, 1}},
		{name: "exactly ten pages", items: items(60), window: 1000, wantPageSizes: []int{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}},
		{name: "truncated after ten pages", items: items(61), window: 1000, wantPageSizes: []int{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}, wantRemaining: 1},
		{name: "oversized item gets its own page", items: []SourceItem{{Text: strings.Repeat("字", 900)}, item}, window: 1000, wantPageSizes: []int{1, 1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			pages, remaining := PaginateSources(tc.items, tc.window)
			sizes := make([]int, 0, len(pages))
			for _, p := range pages {
				sizes = append(sizes, len(p))
			}
			if len(sizes) != len(tc.wantPageSizes) || remaining != tc.wantRemaining {
				t.Fatalf("pages = %v remaining = %d, want %v %d", sizes, remaining, tc.wantPageSizes, tc.wantRemaining)
			}
			for i := range sizes {
				if sizes[i] != tc.wantPageSizes[i] {
					t.Fatalf("pages = %v, want %v", sizes, tc.wantPageSizes)
				}
			}
		})
	}
}
