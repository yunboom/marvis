package embedding

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func vector(seed float32) []float32 {
	v := make([]float32, Dimensions)
	v[0] = seed

	return v
}

func TestDisabledClientMakesNoRequest(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer srv.Close()

	for name, cfg := range map[string]Config{
		"no base url": {APIKey: "k", Model: "m"},
		"no api key":  {BaseURL: srv.URL, Model: "m"},
		"no model":    {BaseURL: srv.URL, APIKey: "k"},
	} {
		c := New(cfg)
		if c.Enabled() {
			t.Errorf("%s: enabled", name)
		}
		if _, err := c.Embed(context.Background(), []string{"x"}); err != ErrNotConfigured {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if calls.Load() != 0 {
		t.Errorf("upstream calls = %d", calls.Load())
	}
}

func TestEmbedSendsBatchAndOrdersVectors(t *testing.T) {
	var got embeddingsRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("request %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		// Out of order on purpose: the client must sort by index.
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
			{"index": 1, "embedding": vector(2)},
			{"index": 0, "embedding": vector(1)},
		}})
	}))
	defer srv.Close()

	c := New(Config{BaseURL: srv.URL + "/v1/", APIKey: "secret", Model: "bge-m3"})
	vectors, err := c.Embed(context.Background(), []string{"a", "b"})
	if err != nil {
		t.Fatalf("embed: %v", err)
	}

	if got.Model != "bge-m3" || got.Dimensions != Dimensions || len(got.Input) != 2 || got.EncodingFormat != encodingFloat {
		t.Errorf("request = %+v", got)
	}
	if len(vectors) != 2 || vectors[0][0] != 1 || vectors[1][0] != 2 {
		t.Errorf("vectors not in input order")
	}
}

func TestEmbedErrors(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"status": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"message":"slow down"}}`))
		},
		"count": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"index": 0, "embedding": vector(1)}}})
		},
		"dimensions": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
				{"index": 0, "embedding": []float32{1}}, {"index": 1, "embedding": []float32{1}},
			}})
		},
	}
	for name, handler := range cases {
		srv := httptest.NewServer(handler)
		c := New(Config{BaseURL: srv.URL, APIKey: "secret", Model: "m"})
		_, err := c.Embed(context.Background(), []string{"a", "b"})
		srv.Close()

		if err == nil {
			t.Errorf("%s: no error", name)
			continue
		}
		if strings.Contains(err.Error(), "secret") {
			t.Errorf("%s: error leaks the key: %v", name, err)
		}
	}
}

func TestEmbedRejectsOversizedBatch(t *testing.T) {
	c := New(Config{BaseURL: "http://127.0.0.1:1", APIKey: "k", Model: "m"})
	if c.BatchSize() != DefaultBatchSize {
		t.Fatalf("default batch size = %d, want %d", c.BatchSize(), DefaultBatchSize)
	}
	if _, err := c.Embed(context.Background(), make([]string, DefaultBatchSize+1)); err == nil {
		t.Error("oversized batch accepted")
	}

	small := New(Config{BaseURL: "http://127.0.0.1:1", APIKey: "k", Model: "m", BatchSize: 3})
	if _, err := small.Embed(context.Background(), make([]string, 4)); err == nil {
		t.Error("batch over the configured size accepted")
	}
}

func TestParseBatchSize(t *testing.T) {
	cases := map[string]int{
		"":     DefaultBatchSize,
		"abc":  DefaultBatchSize,
		"25":   25,
		" 7 ":  7,
		"0":    MinBatchSize,
		"-3":   MinBatchSize,
		"1":    1,
		"100":  100,
		"5000": MaxBatchSize,
	}
	for raw, want := range cases {
		if got := ParseBatchSize(raw); got != want {
			t.Errorf("ParseBatchSize(%q) = %d, want %d", raw, got, want)
		}
	}
}
