// Package embedding calls an OpenAI-compatible /v1/embeddings endpoint. It
// backs the vector half of knowledge base hybrid search and is configured on
// its own (MARVIS_EMBEDDING_*), separate from the chat assist layer in
// pkg/llm.
//
// What it sends upstream: the plain text of mainline knowledge base blocks
// when they are indexed, and the search query of every knowledge base search.
// A client missing any of the base URL, API key or model is disabled and never
// builds a request; search then stays keyword-only.
package embedding

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// Dimensions is the vector size every request asks for; it matches the
// vector(1024) column of kb_block_embedding.
const Dimensions = 1024

// Batch sizes: how many inputs one request carries. Gateways differ (Qwen
// text-embedding-v3 takes at most 10), so the size is configurable through
// MARVIS_EMBEDDING_BATCH_SIZE within [MinBatchSize, MaxBatchSize].
const (
	DefaultBatchSize = 10
	MinBatchSize     = 1
	MaxBatchSize     = 100
)

// defaultTimeout bounds a request whose context has no deadline.
const defaultTimeout = 60 * time.Second

// maxErrorBody is how much of an upstream error body ends up in an error.
const maxErrorBody = 300

// embeddingsPath is appended to the base URL, which already ends in /v1.
const embeddingsPath = "/embeddings"

// encodingFloat asks for plain JSON float arrays rather than base64.
const encodingFloat = "float"

// ErrNotConfigured is returned by Embed on a disabled client.
var ErrNotConfigured = errors.New("embedding: base URL, API key and model are required")

// Config configures a Client. All three of BaseURL, APIKey and Model must be
// set to enable it.
type Config struct {
	// BaseURL is the OpenAI-compatible API root including /v1, for example
	// https://api.openai.com/v1. Maps to MARVIS_EMBEDDING_BASE_URL.
	BaseURL string
	// APIKey is sent as a bearer token. Maps to MARVIS_EMBEDDING_API_KEY.
	APIKey string
	// Model names the embedding model. Maps to MARVIS_EMBEDDING_MODEL.
	Model string
	// BatchSize is the most inputs one request carries; 0 means
	// DefaultBatchSize. Maps to MARVIS_EMBEDDING_BATCH_SIZE.
	BatchSize int
	// HTTPClient replaces the default transport; a test seam.
	HTTPClient *http.Client
}

// Client embeds texts through an OpenAI-compatible endpoint.
type Client struct {
	endpoint  string
	apiKey    string
	model     string
	batchSize int
	http      *http.Client
}

// ParseBatchSize reads MARVIS_EMBEDDING_BATCH_SIZE: empty or not a number is
// DefaultBatchSize, anything outside [MinBatchSize, MaxBatchSize] is clamped.
func ParseBatchSize(raw string) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return DefaultBatchSize
	}

	return min(max(n, MinBatchSize), MaxBatchSize)
}

// New builds a client; it is disabled unless the config is complete.
func New(cfg Config) *Client {
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}

	batchSize := cfg.BatchSize
	if batchSize == 0 {
		batchSize = DefaultBatchSize
	}

	c := &Client{
		apiKey:    strings.TrimSpace(cfg.APIKey),
		model:     strings.TrimSpace(cfg.Model),
		batchSize: min(max(batchSize, MinBatchSize), MaxBatchSize),
		http:      httpClient,
	}
	if base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/"); base != "" {
		c.endpoint = base + embeddingsPath
	}

	return c
}

// Enabled reports whether the client has a base URL, an API key and a model.
func (c *Client) Enabled() bool {
	return c != nil && c.endpoint != "" && c.apiKey != "" && c.model != ""
}

// Model is the configured model name; vectors of different models are not
// comparable.
func (c *Client) Model() string {
	if c == nil {
		return ""
	}

	return c.model
}

// BatchSize is the most inputs one Embed call accepts.
func (c *Client) BatchSize() int {
	if c == nil {
		return DefaultBatchSize
	}

	return c.batchSize
}

type embeddingsRequest struct {
	Model          string   `json:"model"`
	Input          []string `json:"input"`
	Dimensions     int      `json:"dimensions"`
	EncodingFormat string   `json:"encoding_format"`
}

type embeddingsResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

// Embed returns one Dimensions-long vector per input, in input order. At most
// BatchSize inputs go in one call.
func (c *Client) Embed(ctx context.Context, inputs []string) ([][]float32, error) {
	if !c.Enabled() {
		return nil, ErrNotConfigured
	}
	if len(inputs) == 0 {
		return [][]float32{}, nil
	}
	if len(inputs) > c.batchSize {
		return nil, errors.Errorf("embedding: %d inputs exceed the batch size of %d", len(inputs), c.batchSize)
	}

	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, defaultTimeout)
		defer cancel()
	}

	body, err := json.Marshal(embeddingsRequest{Model: c.model, Input: inputs, Dimensions: Dimensions, EncodingFormat: encodingFloat})
	if err != nil {
		return nil, errors.WithStack(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, errors.WithStack(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, errors.Wrapf(err, "embedding request model=%s inputs=%d", c.model, len(inputs))
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return nil, errors.Errorf("embedding: upstream status %d model=%s: %s", resp.StatusCode, c.model, strings.TrimSpace(string(snippet)))
	}

	var parsed embeddingsResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, errors.Wrapf(err, "decode embedding response model=%s", c.model)
	}

	return orderVectors(parsed, len(inputs))
}

// orderVectors puts the vectors back in input order and checks there is one
// full-size vector per input.
func orderVectors(parsed embeddingsResponse, want int) ([][]float32, error) {
	if len(parsed.Data) != want {
		return nil, errors.Errorf("embedding: got %d vectors for %d inputs", len(parsed.Data), want)
	}

	data := parsed.Data
	sort.SliceStable(data, func(i, j int) bool { return data[i].Index < data[j].Index })

	out := make([][]float32, want)
	for i, item := range data {
		if item.Index != i {
			return nil, errors.Errorf("embedding: vector index %d out of order", item.Index)
		}
		if len(item.Embedding) != Dimensions {
			return nil, errors.Errorf("embedding: vector %d has %d dimensions, want %d", i, len(item.Embedding), Dimensions)
		}
		out[i] = item.Embedding
	}

	return out, nil
}
