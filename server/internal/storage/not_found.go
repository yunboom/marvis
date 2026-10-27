package storage

import (
	"errors"
	"io/fs"

	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// IsNotFound reports whether a GetReader error means the object is missing,
// as opposed to a transport or permission failure.
func IsNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, fs.ErrNotExist) {
		return true
	}

	var noSuchKey *types.NoSuchKey

	return errors.As(err, &noSuchKey)
}
