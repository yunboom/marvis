package main

import (
	"net/netip"
	"testing"
)

func TestParseTrustedProxies(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		in   string
		want []string // expressed as String() forms to keep the test readable
	}{
		{"empty", "", nil},
		{"whitespace only", "   \t  ", nil},
		{"one CIDR", "10.0.0.0/8", []string{"10.0.0.0/8"}},
		{"multiple CIDRs", "10.0.0.0/8, 127.0.0.1/32 ,::1/128", []string{"10.0.0.0/8", "127.0.0.1/32", "::1/128"}},
		{"invalid entries dropped", "10.0.0.0/8, not-a-cidr , 192.168.0.0/16", []string{"10.0.0.0/8", "192.168.0.0/16"}},
		{"all invalid → nil", "garbage, also-garbage", nil},
		{"empty entries skipped", ",10.0.0.0/8,,", []string{"10.0.0.0/8"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseTrustedProxies(tc.in)
			var gotStr []string
			for _, p := range got {
				gotStr = append(gotStr, p.String())
			}
			if !sliceEq(gotStr, tc.want) {
				t.Fatalf("parseTrustedProxies(%q) = %v, want %v", tc.in, gotStr, tc.want)
			}
		})
	}
}

func TestParseTrustedProxies_PrefixesAreUsable(t *testing.T) {
	// Make sure the returned prefixes actually do containment checks
	// correctly — guards against returning malformed netip.Prefix values
	// that would silently never match.
	got := parseTrustedProxies("10.0.0.0/8,127.0.0.1/32")
	tests := []struct {
		addr string
		want bool
	}{
		{"10.1.2.3", true},
		{"127.0.0.1", true},
		{"203.0.113.5", false},
	}
	for _, tc := range tests {
		addr := netip.MustParseAddr(tc.addr)
		var hit bool
		for _, p := range got {
			if p.Contains(addr) {
				hit = true
				break
			}
		}
		if hit != tc.want {
			t.Errorf("contains(%s) = %v, want %v", tc.addr, hit, tc.want)
		}
	}
}

func TestEffectiveTrustedProxies(t *testing.T) {
	t.Parallel()

	loopback := []string{"127.0.0.1/32", "::1/128"}
	cases := []struct {
		name       string
		raw        string
		lanEnabled bool
		want       []string
	}{
		{"empty and LAN off trusts nothing", "", false, nil},
		{"empty and LAN on trusts loopback", "", true, loopback},
		{"whitespace only and LAN on trusts loopback", "  \t ", true, loopback},
		{"explicit list wins over LAN default", "10.0.0.0/8", true, []string{"10.0.0.0/8"}},
		{"explicit list is used when LAN is off", "10.0.0.0/8", false, []string{"10.0.0.0/8"}},
		{"all-invalid list is not replaced by the LAN default", "garbage", true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			for _, p := range effectiveTrustedProxies(tc.raw, tc.lanEnabled) {
				got = append(got, p.String())
			}
			if !sliceEq(got, tc.want) {
				t.Fatalf("effectiveTrustedProxies(%q, %v) = %v, want %v", tc.raw, tc.lanEnabled, got, tc.want)
			}
		})
	}
}

func sliceEq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
