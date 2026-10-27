package kb

import (
	"math"
	"testing"
)

func rrf(ranks ...int) float64 {
	var s float64
	for _, r := range ranks {
		s += 1 / float64(RRFK+r)
	}

	return s
}

func TestFuseRRF(t *testing.T) {
	keyword := []RankedBlock{{"A", "a1"}, {"B", "b1"}, {"C", ""}}
	vector := []RankedBlock{{"B", "b1"}, {"D", "d1"}, {"A", "a2"}, {"A", "a1"}}

	got := FuseRRF(keyword, vector)

	want := []FusedPage{
		// B is second in keyword and first in vector: both ranks add up.
		{"B", "b1", rrf(2, 1)},
		// A's a1 hits both lists (keyword 1, vector 4) and beats a2 (vector 3).
		{"A", "a1", rrf(1, 4)},
		{"D", "d1", rrf(2)},
		{"C", "", rrf(3)},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d pages: %+v", len(got), got)
	}
	for i := range want {
		if got[i].PageID != want[i].PageID || got[i].BlockID != want[i].BlockID || math.Abs(got[i].Score-want[i].Score) > 1e-12 {
			t.Errorf("page %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestFuseRRFSingleListKeepsOrder(t *testing.T) {
	got := FuseRRF([]RankedBlock{{"A", "x"}, {"B", "y"}, {"A", "z"}})
	if len(got) != 2 || got[0].PageID != "A" || got[0].BlockID != "x" || got[1].PageID != "B" {
		t.Errorf("got %+v", got)
	}
}

func TestFuseRRFTiesKeepFirstAppearance(t *testing.T) {
	got := FuseRRF([]RankedBlock{{"A", "a"}}, []RankedBlock{{"B", "b"}})
	if len(got) != 2 || got[0].PageID != "A" || got[1].PageID != "B" {
		t.Errorf("got %+v", got)
	}
}

func TestFuseRRFDuplicateInOneListCountsOnce(t *testing.T) {
	got := FuseRRF([]RankedBlock{{"A", "a"}, {"A", "a"}})
	if len(got) != 1 || math.Abs(got[0].Score-rrf(1)) > 1e-12 {
		t.Errorf("got %+v", got)
	}
}

func TestFuseRRFEmpty(t *testing.T) {
	if got := FuseRRF(nil, nil); len(got) != 0 {
		t.Errorf("got %+v", got)
	}
}
