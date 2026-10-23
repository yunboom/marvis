package handler

import (
	_ "embed"
	"encoding/base64"
)

// mikaAvatarSVG is the default agent's artwork. It mirrors
// packages/views/onboarding/components/mika-avatar.svg, which onboarding shows
// before the agent exists; the two must move together or onboarding shows one
// face and the created agent another.
//
//go:embed mika_avatar.svg
var mikaAvatarSVG []byte

// mikaAgentAvatarURL is stored on the row as a data URI so it renders on every
// client without a storage object, the same way avatar handling already passes
// through `data:` values untouched.
var mikaAgentAvatarURL = "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString(mikaAvatarSVG)
