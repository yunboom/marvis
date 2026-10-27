package kb

import (
	"encoding/base64"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/pkg/errors"
)

// Page list limits (GET /api/kb/bases/{kb}/pages).
const (
	// DefaultPageListLimit is the page size when the request sets none.
	DefaultPageListLimit = 200
	// MaxPageListLimit is the largest page size a request may ask for.
	MaxPageListLimit = 200
)

// ErrInvalidCursor is returned for a cursor this server did not issue.
var ErrInvalidCursor = errors.New("invalid cursor")

// PageCursor is the keyset position after which the next page of one tree
// level starts: the sort key and id of the last page returned.
type PageCursor struct {
	Position string `json:"p"`
	ID       string `json:"i"`
}

// EncodeCursor renders a cursor as an opaque URL-safe token.
func EncodeCursor(c PageCursor) string {
	raw, err := json.Marshal(c)
	if err != nil {
		// Two strings always marshal.
		panic(err)
	}

	return base64.RawURLEncoding.EncodeToString(raw)
}

// DecodeCursor parses a token from EncodeCursor. An empty token means "from
// the start" and returns ok=false without an error.
func DecodeCursor(token string) (PageCursor, bool, error) {
	if token == "" {
		return PageCursor{}, false, nil
	}

	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return PageCursor{}, false, ErrInvalidCursor
	}

	var c PageCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return PageCursor{}, false, ErrInvalidCursor
	}
	if _, err := uuid.Parse(c.ID); err != nil {
		return PageCursor{}, false, ErrInvalidCursor
	}

	return c, true, nil
}

// After reports whether the sort key (position, id) comes after the cursor.
func (c PageCursor) After(position, id string) bool {
	if position != c.Position {
		return position > c.Position
	}

	return id > c.ID
}
