package kb

import "strings"

// positionDigits orders sibling sort keys (kb_page.position). Keys compare as
// plain strings, so the digits are in ASCII order.
const positionDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// PositionBetween returns a sort key strictly between before and after so a
// page can be placed without renumbering its siblings (fractional indexing).
// An empty before means "no lower bound", an empty after "no upper bound".
// When the bounds are out of order the key goes after before.
func PositionBetween(before, after string) string {
	if after != "" && before >= after {
		after = ""
	}

	return positionMidpoint(before, after)
}

// positionMidpoint follows the midpoint of rocicorp/fractional-indexing for
// keys without an integer part: a < b (b empty = +infinity).
func positionMidpoint(a, b string) string {
	if b != "" {
		n := 0
		for n < len(b) && positionDigitAt(a, n) == b[n] {
			n++
		}
		if n > 0 {
			rest := ""
			if n < len(a) {
				rest = a[n:]
			}

			return b[:n] + positionMidpoint(rest, b[n:])
		}
	}

	digitA := 0
	if a != "" {
		digitA = max(strings.IndexByte(positionDigits, a[0]), 0)
	}
	digitB := len(positionDigits)
	if b != "" {
		if i := strings.IndexByte(positionDigits, b[0]); i >= 0 {
			digitB = i
		}
	}

	if digitB-digitA > 1 {
		return string(positionDigits[(digitA+digitB)/2])
	}
	if b != "" && len(b) > 1 {
		return b[:1]
	}

	rest := ""
	if len(a) > 1 {
		rest = a[1:]
	}

	return string(positionDigits[digitA]) + positionMidpoint(rest, "")
}

// positionDigitAt reads digit n of a key, treating missing digits as the
// smallest digit.
func positionDigitAt(key string, n int) byte {
	if n < len(key) {
		return key[n]
	}

	return positionDigits[0]
}
