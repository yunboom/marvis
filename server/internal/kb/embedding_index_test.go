package kb

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

func TestPlanEmbedding(t *testing.T) {
	live := pgtype.UUID{Bytes: [16]byte{1}, Valid: true}
	gone := pgtype.UUID{Bytes: [16]byte{2}, Valid: true}
	unchanged := ContentHash(EmbeddingInput("Same text."))

	pages := []db.ListKbPagesForEmbeddingRow{
		{ID: live, Blocks: []byte(`[
			{"id":"b001","kind":"text","content":"Same text."},
			{"id":"b002","kind":"text","content":"New **text**."},
			{"id":"b003","kind":"text","content":"---"}
		]`)},
		{ID: gone, Blocks: []byte(`[{"id":"b001","kind":"text","content":"x"}]`), DeletedAt: pgtype.Timestamptz{Valid: true}},
	}
	existing := []db.ListKbBlockEmbeddingHashesRow{
		{PageID: live, BlockID: "b001", ContentHash: unchanged, Model: "m"},
		{PageID: live, BlockID: "b009", ContentHash: "old", Model: "m"},
		{PageID: gone, BlockID: "b001", ContentHash: "x", Model: "m"},
	}

	targets, stale, livePages, err := planEmbedding(pages, existing, "m")
	if err != nil {
		t.Fatal(err)
	}

	if len(targets) != 1 || targets[0].blockID != "b002" || targets[0].text != "New text." {
		t.Errorf("targets = %+v", targets)
	}
	if len(stale) != 2 || stale[0].BlockID != "b009" || stale[1].PageID != gone {
		t.Errorf("stale = %+v", stale)
	}
	if len(livePages) != 1 || livePages[0] != live {
		t.Errorf("live = %+v", livePages)
	}

	// Another model re-embeds every block with text.
	targets, _, _, err = planEmbedding(pages, existing, "other")
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 2 {
		t.Errorf("model change targets = %d", len(targets))
	}
}

func TestEmbeddingInputCaps(t *testing.T) {
	long := strings.Repeat("字", embedInputRunes+10)
	if got := []rune(EmbeddingInput(long)); len(got) != embedInputRunes {
		t.Errorf("capped to %d runes", len(got))
	}
	if EmbeddingInput("  ") != "" {
		t.Error("blank block has input")
	}
}

func TestVectorText(t *testing.T) {
	if got := VectorText([]float32{1, -0.5, 0.25}); got != "[1,-0.5,0.25]" {
		t.Errorf("got %s", got)
	}
}
