package handler

import "testing"

func TestIsStandaloneMode(t *testing.T) {
	cases := []struct {
		value string
		want  bool
	}{
		{"1", true},
		{"true", true},
		{"TRUE", true},
		{" true ", true},
		{"", false},
		{"0", false},
		{"false", false},
		{"yes", false},
		{"garbage", false},
	}
	for _, c := range cases {
		t.Setenv(StandaloneEnv, c.value)
		if got := IsStandaloneMode(); got != c.want {
			t.Errorf("IsStandaloneMode() with %q = %v, want %v", c.value, got, c.want)
		}
	}
}
