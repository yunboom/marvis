package util

import "testing"

func TestBasePathFromEnv(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "unset", raw: "", want: ""},
		{name: "slashes only", raw: "/", want: ""},
		{name: "plain", raw: "/marvis", want: "/marvis"},
		{name: "no leading slash", raw: "marvis", want: "/marvis"},
		{name: "extra slashes and spaces", raw: "  //marvis//  ", want: "/marvis"},
		{name: "nested", raw: "/tools/marvis/", want: "/tools/marvis"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(basePathEnv, tc.raw)

			if got := BasePathFromEnv(); got != tc.want {
				t.Fatalf("BasePathFromEnv() with %q = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestAppURLFromEnv(t *testing.T) {
	cases := []struct {
		name           string
		appURL         string
		frontendOrigin string
		basePath       string
		want           string
	}{
		{name: "nothing set", basePath: "/marvis", want: ""},
		{name: "app url without prefix", appURL: "https://example.com/", want: "https://example.com"},
		{name: "app url with prefix", appURL: "https://example.com", basePath: "marvis/", want: "https://example.com/marvis"},
		{name: "falls back to frontend origin", frontendOrigin: "http://localhost:13840", basePath: "/marvis", want: "http://localhost:13840/marvis"},
		{name: "app url wins over frontend origin", appURL: "https://app.example.com", frontendOrigin: "http://localhost:3000", want: "https://app.example.com"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(appURLEnv, tc.appURL)
			t.Setenv(frontendOriginEnv, tc.frontendOrigin)
			t.Setenv(basePathEnv, tc.basePath)

			if got := AppURLFromEnv(); got != tc.want {
				t.Fatalf("AppURLFromEnv() = %q, want %q", got, tc.want)
			}
		})
	}
}
