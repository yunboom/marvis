package kb

import (
	"regexp"
	"strings"

	"github.com/pkg/errors"
)

// AnchorContextRunes is how much text around a quote an annotation keeps on
// each side (spec 7.6: 32 characters) to find the sentence again after the
// page is rewritten.
const AnchorContextRunes = 32

// maxApproxCells bounds one approximate search (pattern length x text
// length) so a huge page cannot stall a merge.
const maxApproxCells = 20_000_000

// minFuzzyQuoteRunes is the shortest quote matched approximately on its own;
// shorter quotes match too many places by chance.
const minFuzzyQuoteRunes = 6

// minMovedQuoteRunes is the shortest quote that may move to another block on
// its words alone, without any matching context.
const minMovedQuoteRunes = 16

// ErrQuoteNotFound is returned when a quote is not in the block it names.
var ErrQuoteNotFound = errors.New("quote not found in block")

// footnoteRefPattern matches footnote references ([^id]); the reading page
// shows them as citation numbers, so a selected sentence never contains them.
var footnoteRefPattern = regexp.MustCompile(`\[\^[^\]\s]+\]`)

// Anchor is where an annotation sits on a page: a sentence of a block and the
// text around it.
type Anchor struct {
	BlockID string
	Quote   string
	Prefix  string
	Suffix  string
}

// AnchorOutcome says how relocation found an annotated sentence.
type AnchorOutcome int

const (
	// AnchorKept means the sentence is still in its block.
	AnchorKept AnchorOutcome = iota
	// AnchorMoved means the same words are now in another block.
	AnchorMoved
	// AnchorRewritten means the surrounding text located a reworded sentence.
	AnchorRewritten
	// AnchorLost means the sentence is gone; the annotation falls back to the
	// whole page.
	AnchorLost
)

// AnchorText is the text of a block that quotes are matched against: its
// plain text without footnote references, whitespace collapsed.
func AnchorText(markdown string) string {
	return NormalizeQuote(footnoteRefPattern.ReplaceAllString(PlainText(markdown), " "))
}

// NormalizeQuote collapses runs of whitespace into one space and trims, so a
// selection spanning lines compares equal to the stored text.
func NormalizeQuote(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// blockSpan is where a block's text lies in the page text, in runes.
type blockSpan struct {
	id    string
	start int
	end   int
}

// pageText is the anchor text of every block, joined by newlines.
type pageText struct {
	runes []rune
	spans []blockSpan
}

func newPageText(blocks []Block) pageText {
	var pt pageText
	for i, block := range blocks {
		if i > 0 {
			pt.runes = append(pt.runes, '\n')
		}
		start := len(pt.runes)
		pt.runes = append(pt.runes, []rune(AnchorText(block.Content))...)
		pt.spans = append(pt.spans, blockSpan{id: block.ID, start: start, end: len(pt.runes)})
	}

	return pt
}

func (pt pageText) span(blockID string) (blockSpan, bool) {
	for _, s := range pt.spans {
		if s.id == blockID {
			return s, true
		}
	}

	return blockSpan{}, false
}

// spanAt returns the block whose text holds rune offset pos.
func (pt pageText) spanAt(pos int) (blockSpan, bool) {
	for _, s := range pt.spans {
		if pos >= s.start && pos < s.end {
			return s, true
		}
	}

	return blockSpan{}, false
}

// anchorAt builds the anchor of runes[start:end] in block id.
func (pt pageText) anchorAt(blockID string, start, end int) Anchor {
	return Anchor{
		BlockID: blockID,
		Quote:   string(pt.runes[start:end]),
		Prefix:  string(pt.runes[max(0, start-AnchorContextRunes):start]),
		Suffix:  string(pt.runes[end:min(len(pt.runes), end+AnchorContextRunes)]),
	}
}

// contextScore is how many characters of the remembered context still sit
// right next to runes[start:end].
func (pt pageText) contextScore(start, end int, prefix, suffix []rune) int {
	score := 0
	for i := 1; i <= len(prefix) && start-i >= 0 && pt.runes[start-i] == prefix[len(prefix)-i]; i++ {
		score++
	}
	for i := 0; i < len(suffix) && end+i < len(pt.runes) && pt.runes[end+i] == suffix[i]; i++ {
		score++
	}

	return score
}

// bestOccurrence finds quote within runes[from:to], preferring the
// occurrence whose surroundings match the remembered context best.
func (pt pageText) bestOccurrence(quote []rune, from, to int, prefix, suffix []rune) (int, bool) {
	best, bestScore := -1, -1
	for i := from; i+len(quote) <= to; i++ {
		if !runesEqual(pt.runes[i:i+len(quote)], quote) {
			continue
		}
		if score := pt.contextScore(i, i+len(quote), prefix, suffix); score > bestScore {
			best, bestScore = i, score
		}
	}

	return best, best >= 0
}

// LocateQuote anchors a new annotation on a sentence of a block. Prefix and
// suffix hints only choose between repeats of the sentence in the block; the
// stored context is always taken from the page itself.
func LocateQuote(blocks []Block, blockID, quote, prefixHint, suffixHint string) (Anchor, error) {
	q := []rune(NormalizeQuote(quote))
	if len(q) == 0 {
		return Anchor{}, errors.WithStack(ErrQuoteNotFound)
	}

	pt := newPageText(blocks)
	span, ok := pt.span(blockID)
	if !ok {
		return Anchor{}, errors.Wrapf(ErrBlockNotFound, "block_id=%s", blockID)
	}

	start, found := pt.bestOccurrence(q, span.start, span.end, []rune(prefixHint), []rune(suffixHint))
	if !found {
		return Anchor{}, errors.Wrapf(ErrQuoteNotFound, "block_id=%s", blockID)
	}

	return pt.anchorAt(blockID, start, start+len(q)), nil
}

// Relocate finds an annotated sentence on a rewritten page (spec 7.6): first
// in its own block, then the same words anywhere on the page, then by the 32
// characters remembered on each side, and finally by an approximate match of
// the sentence itself. When nothing matches the anchor is lost and the
// caller attaches the annotation to the whole page.
func Relocate(a Anchor, blocks []Block) (Anchor, AnchorOutcome) {
	q := []rune(NormalizeQuote(a.Quote))
	if len(q) == 0 {
		return a, AnchorLost
	}

	pt := newPageText(blocks)
	prefix, suffix := []rune(a.Prefix), []rune(a.Suffix)

	if span, ok := pt.span(a.BlockID); ok {
		if start, found := pt.bestOccurrence(q, span.start, span.end, prefix, suffix); found {
			return pt.anchorAt(span.id, start, start+len(q)), AnchorKept
		}
	}

	// A normalized quote has no newline, so a match never crosses blocks. A
	// short quote elsewhere only counts when some context still matches; a
	// common phrase would otherwise jump to an unrelated sentence.
	if start, found := pt.bestOccurrence(q, 0, len(pt.runes), prefix, suffix); found &&
		(len(q) >= minMovedQuoteRunes || pt.contextScore(start, start+len(q), prefix, suffix) > 0) {
		span, _ := pt.spanAt(start)
		return pt.anchorAt(span.id, start, start+len(q)), AnchorMoved
	}

	if anchor, ok := pt.relocateByContext(len(q), prefix, suffix); ok {
		return anchor, AnchorRewritten
	}

	if anchor, ok := pt.relocateByQuote(q); ok {
		return anchor, AnchorRewritten
	}

	return a, AnchorLost
}

// relocateByContext takes the text between where the remembered prefix now
// ends and the remembered suffix now starts. When only one side still
// matches, the sentence next to it (up to a sentence end) is taken.
func (pt pageText) relocateByContext(quoteLen int, prefix, suffix []rune) (Anchor, bool) {
	maxSpan := 4*quoteLen + 64

	from, preOK := 0, false
	if len(prefix) > 0 {
		if m, ok := approxFind(pt.runes, prefix, 0, len(pt.runes)); ok && m.dist <= len(prefix)/4 {
			from, preOK = m.end, true
		}
	}

	to, sufOK := 0, false
	if len(suffix) > 0 {
		lo, hi := 0, len(pt.runes)
		if preOK {
			lo, hi = from, min(len(pt.runes), from+maxSpan+len(suffix)+len(suffix)/4)
		}
		if m, ok := approxFind(pt.runes, suffix, lo, hi); ok && m.dist <= len(suffix)/4 {
			to, sufOK = m.start, true
		}
	}

	switch {
	case preOK && sufOK:
	case sufOK:
		from = pt.sentenceStart(to, maxSpan)
	case preOK:
		to = pt.sentenceEnd(from, maxSpan)
	default:
		return Anchor{}, false
	}

	return pt.clipToBlock(from, to, maxSpan)
}

// sentenceTerminators end a sentence when only one side of the context is
// left to bound it.
const sentenceTerminators = "。！？；.!?;\n"

// sentenceStart walks back from end (exclusive) to just after the previous
// sentence end. The character right before end is skipped: it usually ends
// the sentence being looked for.
func (pt pageText) sentenceStart(end, limit int) int {
	i := end - 2
	for ; i >= 0 && end-i <= limit; i-- {
		if strings.ContainsRune(sentenceTerminators, pt.runes[i]) {
			break
		}
	}

	return i + 1
}

// sentenceEnd walks forward from start to the end of that sentence,
// terminator included; a newline (block end) is not included.
func (pt pageText) sentenceEnd(start, limit int) int {
	for i := start; i < len(pt.runes) && i-start < limit; i++ {
		switch r := pt.runes[i]; {
		case r == '\n':
			return i
		case strings.ContainsRune(sentenceTerminators, r):
			return i + 1
		}
	}

	return min(len(pt.runes), start+limit)
}

// relocateByQuote matches the sentence itself with a few edits allowed.
func (pt pageText) relocateByQuote(q []rune) (Anchor, bool) {
	if len(q) < minFuzzyQuoteRunes {
		return Anchor{}, false
	}

	m, ok := approxFind(pt.runes, q, 0, len(pt.runes))
	if !ok || m.dist > len(q)/4 {
		return Anchor{}, false
	}

	return pt.clipToBlock(m.start, m.end, len(q)*2)
}

// clipToBlock turns runes[from:to] into an anchor: surrounding whitespace is
// trimmed and the range is cut at the end of the block it starts in.
func (pt pageText) clipToBlock(from, to, maxSpan int) (Anchor, bool) {
	for from < to && isAnchorSpace(pt.runes[from]) {
		from++
	}
	span, ok := pt.spanAt(from)
	if !ok || from >= to {
		return Anchor{}, false
	}

	to = min(to, span.end)
	for to > from && isAnchorSpace(pt.runes[to-1]) {
		to--
	}
	if to <= from || to-from > maxSpan {
		return Anchor{}, false
	}

	return pt.anchorAt(span.id, from, to), true
}

func isAnchorSpace(r rune) bool {
	return r == ' ' || r == '\n'
}

func runesEqual(a, b []rune) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}

	return true
}

// approxMatch is a substring text[start:end] matching a pattern with dist
// edits.
type approxMatch struct {
	start int
	end   int
	dist  int
}

// approxFind finds the substring of text[lo:hi] closest to pattern by edit
// distance (Sellers' algorithm: free start and end in the text). Ties go to
// the earliest end. It gives up on searches too large to run inline.
func approxFind(text, pattern []rune, lo, hi int) (approxMatch, bool) {
	m := len(pattern)
	if m == 0 || hi <= lo || m*(hi-lo) > maxApproxCells {
		return approxMatch{}, false
	}

	// Column j holds, for each pattern prefix, the cheapest match ending at
	// text offset j and where that match starts.
	cost := make([]int, m+1)
	start := make([]int, m+1)
	for i := range cost {
		cost[i] = i
		start[i] = lo
	}

	best := approxMatch{start: lo, end: lo, dist: m}
	nextCost := make([]int, m+1)
	nextStart := make([]int, m+1)
	for j := lo + 1; j <= hi; j++ {
		nextCost[0], nextStart[0] = 0, j
		for i := 1; i <= m; i++ {
			sub := cost[i-1]
			if pattern[i-1] != text[j-1] {
				sub++
			}
			c, s := sub, start[i-1]
			if del := nextCost[i-1] + 1; del < c {
				c, s = del, nextStart[i-1]
			}
			if ins := cost[i] + 1; ins < c {
				c, s = ins, start[i]
			}
			nextCost[i], nextStart[i] = c, s
		}
		cost, nextCost = nextCost, cost
		start, nextStart = nextStart, start

		if cost[m] < best.dist {
			best = approxMatch{start: start[m], end: j, dist: cost[m]}
		}
	}

	return best, best.end > best.start
}
