package kb

import (
	"errors"
	"strings"
	"testing"
)

func testBlocks(pairs ...string) []Block {
	out := make([]Block, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, Block{ID: pairs[i], Kind: BlockKindText, Content: pairs[i+1]})
	}

	return out
}

func idsOf(blocks []Block) string {
	return strings.Join(blockIDs(blocks), ",")
}

func TestBlockOps(t *testing.T) {
	page := testBlocks("b001", "# T", "b002", "one", "b003", "two")
	ids := NewBlockIDAllocator(blockIDs(page))

	inserted, newIDs, err := InsertBlocksAfter(page, "b002", "x\n\ny", ids)
	if err != nil || len(newIDs) != 2 {
		t.Fatalf("insert: %v %v", newIDs, err)
	}
	if got := idsOf(inserted); got != "b001,b002,"+newIDs[0]+","+newIDs[1]+",b003" {
		t.Errorf("insert order = %s", got)
	}

	top, _, err := InsertBlocksAfter(page, BlockStart, "z", ids)
	if err != nil || top[0].Content != "z" {
		t.Errorf("insert at start = %+v %v", top, err)
	}

	if _, _, err := InsertBlocksAfter(page, "b404", "z", ids); !errors.Is(err, ErrBlockNotFound) {
		t.Errorf("insert after missing block err = %v", err)
	}

	deleted, err := DeleteBlock(page, "b002")
	if err != nil || idsOf(deleted) != "b001,b003" {
		t.Errorf("delete = %s %v", idsOf(deleted), err)
	}

	moved, err := MoveBlockAfter(page, "b001", "b003")
	if err != nil || idsOf(moved) != "b002,b003,b001" {
		t.Errorf("move after = %s %v", idsOf(moved), err)
	}
	moved, err = MoveBlockAfter(page, "b003", BlockStart)
	if err != nil || idsOf(moved) != "b003,b001,b002" {
		t.Errorf("move to start = %s %v", idsOf(moved), err)
	}

	appended, newIDs, err := AppendBlocks(page, "end", ids)
	if err != nil || appended[3].ID != newIDs[0] || appended[3].Content != "end" {
		t.Errorf("append = %+v %v", appended, err)
	}
	if idsOf(page) != "b001,b002,b003" {
		t.Errorf("ops mutated the input: %s", idsOf(page))
	}
}

func TestStrReplace(t *testing.T) {
	page := testBlocks("b001", "订单号去重", "b002", "交易号")
	ids := NewBlockIDAllocator(blockIDs(page))

	out, blockID, _, err := StrReplace(page, "订单号", "渠道交易号", ids)
	if err != nil || blockID != "b001" || out[0].Content != "渠道交易号去重" {
		t.Fatalf("str_replace = %+v %s %v", out, blockID, err)
	}

	if _, _, _, err := StrReplace(page, "号", "x", ids); !errors.Is(err, ErrStrReplaceMatch) {
		t.Errorf("two matches err = %v", err)
	}
	if _, _, _, err := StrReplace(page, "missing", "x", ids); !errors.Is(err, ErrStrReplaceMatch) {
		t.Errorf("no match err = %v", err)
	}

	out, _, _, err = StrReplace(page, "交易号", "", ids)
	if err != nil || idsOf(out) != "b001" {
		t.Errorf("emptying a block deletes it: %s %v", idsOf(out), err)
	}
}

func TestSetMeta(t *testing.T) {
	header := map[string]any{"type": "Guide", "status": "draft"}

	out, err := SetMeta(header, map[string]any{"status": "stable", "type": nil, "tags": []any{"dev"}})
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "stable" || out["type"] != nil || out["tags"] == nil {
		t.Errorf("set_meta = %+v", out)
	}
	if header["status"] != "draft" {
		t.Errorf("set_meta mutated the input")
	}

	for _, key := range []string{MetaSources, MetaGenerated} {
		if _, err := SetMeta(header, map[string]any{key: "x"}); !errors.Is(err, ErrProtectedMeta) {
			t.Errorf("set_meta %s err = %v", key, err)
		}
	}
}

func TestConflictMarkers(t *testing.T) {
	content := ConflictContent("main", "")
	if content != "<<<<<<< 主线\nmain\n=======\n>>>>>>> 草稿" {
		t.Errorf("conflict content = %q", content)
	}
	if !HasConflictMarkers(content) {
		t.Error("markers not detected")
	}
	if HasConflictMarkers("Title\n=======") {
		t.Error("a setext heading is not a conflict marker")
	}
}

func TestPositionBetween(t *testing.T) {
	cases := []struct{ before, after string }{
		{"", ""}, {"a0", ""}, {"", "a0"}, {"a0", "a1"}, {"a0", "a0V"}, {"a1", "a2"}, {"z", ""}, {"zzz", ""},
	}
	for _, c := range cases {
		got := PositionBetween(c.before, c.after)
		if got <= c.before || (c.after != "" && got >= c.after) {
			t.Errorf("PositionBetween(%q, %q) = %q, not between", c.before, c.after, got)
		}
	}

	if got := PositionBetween("b", "a"); got <= "b" {
		t.Errorf("out-of-order bounds = %q, want after b", got)
	}
}
