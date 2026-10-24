// Package projecticon defines the glyph keys a project icon may hold. Clients
// map each key to a line icon; emoji and other free text are not icons.
package projecticon

import "slices"

// Keys lists every valid project icon key in picker order.
var Keys = []string{
	"folder", "briefcase", "rocket", "target", "flag", "compass", "layers", "box",
	"code", "terminal", "git-branch", "database", "server", "cloud", "smartphone", "monitor",
	"palette", "pen-tool", "book-open", "file-text", "megaphone", "chart-line", "lightbulb", "sparkles",
	"users", "shield", "bug", "wrench", "calendar", "mountain", "leaf", "feather",
}

// Valid reports whether key is a project icon key.
func Valid(key string) bool {
	return slices.Contains(Keys, key)
}
