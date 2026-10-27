package handler

import (
	"os"
	"strconv"
	"strings"
)

// StandaloneEnv marks a server that the desktop app runs on the user's own
// machine (standalone mode). APP_ENV stays production there; behaviour that
// only standalone mode allows is gated on this variable instead.
const StandaloneEnv = "MARVIS_STANDALONE"

// IsStandaloneMode reports whether MARVIS_STANDALONE parses as true. Unset or
// unparseable values count as off so a typo never enables standalone-only
// behaviour on a regular deployment.
func IsStandaloneMode() bool {
	enabled, err := strconv.ParseBool(strings.TrimSpace(os.Getenv(StandaloneEnv)))

	return err == nil && enabled
}
