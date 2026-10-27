package kb

import (
	"strings"
	"unicode"
)

// maxRawNameBytes bounds a raw file name, the common file system limit.
const maxRawNameBytes = 255

// rawKindDirs maps a kb_raw kind to its raw:// directory, the reverse of
// rawDirs.
var rawKindDirs = map[string]string{
	RawKindSource: "sources",
	RawKindAsset:  "assets",
}

// ValidRawKind reports whether kind is a kb_raw kind.
func ValidRawKind(kind string) bool {
	_, ok := rawKindDirs[kind]

	return ok
}

// RawDir is the raw:// directory (and export directory under raw/) holding
// files of a kind: sources or assets.
func RawDir(kind string) string {
	return rawKindDirs[kind]
}

// RawURI is the address pages cite a raw file by: raw://sources/<name>. The
// name is written as stored, the same form `kb raw get` prints.
func RawURI(kind, name string) string {
	return SourceKindRaw + "://" + RawDir(kind) + "/" + name
}

// CleanRawName validates an uploaded file name and returns it trimmed. Names
// are path segments of raw:// uris, so separators, the fragment and query
// marks and control characters are refused.
func CleanRawName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." || len(name) > maxRawNameBytes {
		return "", false
	}
	if strings.ContainsAny(name, `/\#?`) {
		return "", false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", false
		}
	}

	return name, true
}

// rawContentPathPrefix is where the API serves raw files:
// /api/kb/raw/<id>/content.
const rawContentPathPrefix = "/api/kb/raw/"

// RawContentPath is the API path that serves a raw file.
func RawContentPath(id string) string {
	return rawContentPathPrefix + id + "/content"
}

// RawFileKey identifies a raw file within a knowledge base: "<kind>/<name>".
func RawFileKey(kind, name string) string {
	return kind + "/" + name
}

// RawRefsInBlocks lists the raw files that links and images of blocks point
// at, without duplicates.
func RawRefsInBlocks(blocks []Block) []RawRef {
	seen := make(map[string]struct{})
	refs := make([]RawRef, 0)
	for _, block := range blocks {
		for _, dest := range linkAndImageDestinations(block.Content) {
			ref, ok := ParseRawURI(dest)
			if !ok {
				continue
			}
			key := RawFileKey(ref.Kind, ref.Name)
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			refs = append(refs, ref)
		}
	}

	return refs
}

// RawLinks rewrites raw:// link and image destinations of blocks for the
// reading page: a file the knowledge base holds becomes its content path,
// keeping a #page= fragment; ids maps RawFileKey to the file id. Other
// destinations stay as they are.
func RawLinks(blocks []Block, ids map[string]string) []Block {
	out := make([]Block, len(blocks))
	for i, block := range blocks {
		out[i] = block
		out[i].Content = rewriteAllDestinations(block.Content, func(dest string) (string, bool) {
			ref, ok := ParseRawURI(dest)
			if !ok {
				return "", false
			}
			id, found := ids[RawFileKey(ref.Kind, ref.Name)]
			if !found {
				return "", false
			}

			link := RawContentPath(id)
			if _, fragment, hasFragment := strings.Cut(dest, "#"); hasFragment {
				link += "#" + fragment
			}

			return link, true
		})
	}

	return out
}
