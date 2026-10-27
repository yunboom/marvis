package kb

import "sort"

// Search modes (GET /api/kb/search, mode).
const (
	// SearchModeHybrid fused the keyword and vector halves.
	SearchModeHybrid = "hybrid"
	// SearchModeKeyword ran the keyword half only: no embedding model, no
	// pgvector, or the vector half failed.
	SearchModeKeyword = "keyword"
)

// RRFK is the Reciprocal Rank Fusion constant: a block ranked r in one list
// scores 1 / (RRFK + r), ranks starting at 1.
const RRFK = 60

// SearchDepth is how many blocks each half of hybrid search contributes.
const SearchDepth = 50

// RankedBlock is one entry of a ranked result list. BlockID is empty when a
// page matched by its title only.
type RankedBlock struct {
	PageID  string
	BlockID string
}

// FusedPage is a page with its best-scoring block.
type FusedPage struct {
	PageID  string
	BlockID string
	Score   float64
}

type blockKey struct{ page, block string }

// FuseRRF merges ranked block lists with Reciprocal Rank Fusion: a block
// scores the sum of 1 / (RRFK + rank) over the lists it appears in, and a page
// keeps its highest-scoring block. Pages come back by score; ties keep the
// order in which pages first appear, earlier lists first.
func FuseRRF(lists ...[]RankedBlock) []FusedPage {
	scores := map[blockKey]float64{}
	order := make([]blockKey, 0)
	for _, list := range lists {
		seen := map[blockKey]bool{}
		for i, entry := range list {
			key := blockKey{entry.PageID, entry.BlockID}
			// A block listed twice in one list counts at its best rank.
			if seen[key] {
				continue
			}
			seen[key] = true

			if _, ok := scores[key]; !ok {
				order = append(order, key)
			}
			scores[key] += 1 / float64(RRFK+i+1)
		}
	}

	best := map[string]int{}
	pages := make([]FusedPage, 0)
	for _, key := range order {
		score := scores[key]
		at, ok := best[key.page]
		if !ok {
			best[key.page] = len(pages)
			pages = append(pages, FusedPage{PageID: key.page, BlockID: key.block, Score: score})
			continue
		}
		if score > pages[at].Score {
			pages[at].BlockID = key.block
			pages[at].Score = score
		}
	}

	sort.SliceStable(pages, func(i, j int) bool { return pages[i].Score > pages[j].Score })

	return pages
}
