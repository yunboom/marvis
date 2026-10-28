package inbox

import "testing"

func TestCategoryTypes(t *testing.T) {
	seen := map[string]string{}
	for _, category := range []string{CategoryIssue, CategoryKb, CategoryAutopilot} {
		types, ok := CategoryTypes(category)
		if !ok || len(types) == 0 {
			t.Fatalf("category %s has no types", category)
		}
		for _, kind := range types {
			if other, dup := seen[kind]; dup {
				t.Errorf("%s is in both %s and %s", kind, other, category)
			}
			seen[kind] = category
		}
	}

	if types, ok := CategoryTypes(""); !ok || len(types) != 0 {
		t.Errorf("all = %v, %v", types, ok)
	}
	if _, ok := CategoryTypes("chat"); ok {
		t.Error("unknown category accepted")
	}
}
