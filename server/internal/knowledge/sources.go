package knowledge

import (
	"unicode"
	"unicode/utf8"
)

// SourceItem 是每日知识沉淀读取的一条资料：任务、评论或对话消息。
type SourceItem struct {
	Kind   string `json:"kind"`
	URI    string `json:"uri"`
	Title  string `json:"title,omitempty"`
	Author string `json:"author,omitempty"`
	Status string `json:"status,omitempty"`
	At     string `json:"at"`
	Text   string `json:"text"`
}

// SourceItem.Kind 的取值。
const (
	SourceItemTask    = "task"
	SourceItemComment = "comment"
	SourceItemChat    = "chat"
)

const (
	// SourcePageBudgetPercent 是每页资料占上下文窗口的上限百分比。
	SourcePageBudgetPercent = 60
	// SourceMaxPages 是一次沉淀最多读取的页数，超出部分丢弃并标记截断。
	SourceMaxPages = 10
	// SourceItemMaxRunes 是单条资料正文的长度上限，避免一条长描述占满一页。
	SourceItemMaxRunes = 4000
	// sourceItemOverheadTokens 是每条资料的字段名、URI 等固定开销估算。
	sourceItemOverheadTokens = 40
)

// EstimateTokens 粗估文本的 token 数：中日韩字符各算 1 个，其他字符每 4 个算 1 个。
func EstimateTokens(text string) int {
	cjk, other := 0, 0
	for _, r := range text {
		if unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) {
			cjk++
		} else {
			other++
		}
	}

	return cjk + (other+3)/4
}

// TrimSourceText 把正文截到 SourceItemMaxRunes 以内，被截断时末尾加省略号。
func TrimSourceText(text string) string {
	if utf8.RuneCountInString(text) <= SourceItemMaxRunes {
		return text
	}
	runes := []rune(text)

	return string(runes[:SourceItemMaxRunes]) + "…"
}

// PaginateSources 按 token 预算把资料切成页：每页不超过窗口的 SourcePageBudgetPercent，
// 最多 SourceMaxPages 页；装不下的资料丢弃，remaining 是丢弃的条数。单条超过预算的资料独占一页。
func PaginateSources(items []SourceItem, contextWindow int) (pages [][]SourceItem, remaining int) {
	budget := contextWindow * SourcePageBudgetPercent / 100
	var cur []SourceItem
	used := 0
	for i, it := range items {
		cost := sourceItemOverheadTokens + EstimateTokens(it.Title) + EstimateTokens(it.Text)
		if len(cur) > 0 && used+cost > budget {
			pages = append(pages, cur)
			cur, used = nil, 0
		}
		if len(pages) == SourceMaxPages {
			return pages, len(items) - i
		}
		cur = append(cur, it)
		used += cost
	}
	if len(cur) > 0 {
		pages = append(pages, cur)
	}

	return pages, 0
}
