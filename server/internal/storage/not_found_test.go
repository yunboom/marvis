package storage

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

func TestIsNotFound(t *testing.T) {
	local := &LocalStorage{uploadDir: t.TempDir()}
	_, missing := local.GetReader(context.Background(), "nope.bin")

	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil", err: nil, want: false},
		{name: "local missing file", err: missing, want: true},
		{name: "s3 no such key", err: fmt.Errorf("s3 GetObject: %w", &types.NoSuchKey{}), want: true},
		{name: "transport failure", err: errors.New("connection reset"), want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsNotFound(tc.err); got != tc.want {
				t.Fatalf("IsNotFound(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
