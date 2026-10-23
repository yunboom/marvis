package handler

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// larkCardDoc 是测试里解析卡片 JSON 用的通用结构。
type larkCardDoc map[string]any

// parseLarkInviteCardForTest 解析 buildLarkInviteCard 的输出。
func parseLarkInviteCardForTest(t *testing.T, raw string) larkCardDoc {
	t.Helper()

	var doc larkCardDoc
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("card is not valid JSON: %v\n%s", err, raw)
	}

	return doc
}

// header 返回 header 对象。
func (d larkCardDoc) header(t *testing.T) map[string]any {
	t.Helper()

	header, ok := d["header"].(map[string]any)
	if !ok {
		t.Fatalf("card has no header: %v", d)
	}

	return header
}

// title 返回 header.title.content。
func (d larkCardDoc) title(t *testing.T) string {
	t.Helper()

	title, ok := d.header(t)["title"].(map[string]any)
	if !ok {
		t.Fatalf("header has no title: %v", d.header(t))
	}
	content, _ := title["content"].(string)

	return content
}

// elements 返回 body.elements。
func (d larkCardDoc) elements(t *testing.T) []map[string]any {
	t.Helper()

	body, ok := d["body"].(map[string]any)
	if !ok {
		t.Fatalf("card has no body: %v", d)
	}
	raw, ok := body["elements"].([]any)
	if !ok {
		t.Fatalf("body has no elements: %v", body)
	}

	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		element, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("element is not an object: %v", item)
		}
		out = append(out, element)
	}

	return out
}

// markdownContents 返回所有 markdown 元素的 content。
func (d larkCardDoc) markdownContents(t *testing.T) []string {
	t.Helper()

	var out []string
	for _, element := range d.elements(t) {
		if element["tag"] == "markdown" {
			content, _ := element["content"].(string)
			out = append(out, content)
		}
	}

	return out
}

// plainTexts 返回所有 div 元素里 plain_text 的 content。
func (d larkCardDoc) plainTexts(t *testing.T) []string {
	t.Helper()

	var out []string
	for _, element := range d.elements(t) {
		if element["tag"] != "div" {
			continue
		}
		text, ok := element["text"].(map[string]any)
		if !ok || text["tag"] != "plain_text" {
			continue
		}
		content, _ := text["content"].(string)
		out = append(out, content)
	}

	return out
}

// buttons 返回所有 button 元素。
func (d larkCardDoc) buttons(t *testing.T) []map[string]any {
	t.Helper()

	var out []map[string]any
	for _, element := range d.elements(t) {
		if element["tag"] == "button" {
			out = append(out, element)
		}
	}

	return out
}

// buttonByText 按按钮文案查找按钮。
func (d larkCardDoc) buttonByText(t *testing.T, text string) (map[string]any, bool) {
	t.Helper()

	for _, button := range d.buttons(t) {
		label, ok := button["text"].(map[string]any)
		if ok && label["content"] == text {
			return button, true
		}
	}

	return nil, false
}

// behaviorOf 返回按钮的第一个 behavior。
func behaviorOf(t *testing.T, button map[string]any) map[string]any {
	t.Helper()

	behaviors, ok := button["behaviors"].([]any)
	if !ok || len(behaviors) == 0 {
		t.Fatalf("button has no behaviors: %v", button)
	}
	behavior, ok := behaviors[0].(map[string]any)
	if !ok {
		t.Fatalf("behavior is not an object: %v", behaviors[0])
	}

	return behavior
}

// anyContainsLarkText 判断切片里是否有元素包含子串。
func anyContainsLarkText(items []string, sub string) bool {
	for _, item := range items {
		if strings.Contains(item, sub) {
			return true
		}
	}

	return false
}

func newLarkInviteViewForTest() larkInviteCardView {
	return larkInviteCardView{
		State:         larkInviteCardActive,
		InviteID:      "inv-1",
		WorkspaceName: "Dev",
		InviterName:   "林晓",
		Role:          "member",
		ExpiresAt:     time.Date(2026, time.October, 30, 9, 30, 0, 0, time.Local),
		JoinedCount:   3,
	}
}

func TestBuildLarkInviteCard_Active(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.Note = "欢迎加入"

	raw, err := buildLarkInviteCard(view)
	if err != nil {
		t.Fatalf("buildLarkInviteCard: %v", err)
	}
	doc := parseLarkInviteCardForTest(t, raw)

	if doc["schema"] != "2.0" {
		t.Fatalf("schema = %v, want 2.0", doc["schema"])
	}
	config, ok := doc["config"].(map[string]any)
	if !ok || config["update_multi"] != true {
		t.Fatalf("config.update_multi must be true, got %v", doc["config"])
	}
	if got := doc.title(t); got != "工作区邀请" {
		t.Fatalf("title = %q", got)
	}
	if got := doc.header(t)["template"]; got != "blue" {
		t.Fatalf("template = %v, want blue", got)
	}

	markdowns := doc.markdownContents(t)
	if !anyContainsLarkText(markdowns, "**林晓** 邀请你加入工作区 **Dev**") {
		t.Fatalf("sentence missing from markdown: %v", markdowns)
	}

	plain := doc.plainTexts(t)
	if !anyContainsLarkText(plain, "“欢迎加入”") {
		t.Fatalf("note with Chinese quotes missing: %v", plain)
	}
	if !anyContainsLarkText(markdowns, "成员") || !anyContainsLarkText(markdowns, "角色") {
		t.Fatalf("role field missing: %v", markdowns)
	}
	if !anyContainsLarkText(markdowns, "有效期至") || !anyContainsLarkText(markdowns, "10 月 30 日") {
		t.Fatalf("expiry field missing: %v", markdowns)
	}
	if !anyContainsLarkText(plain, "3 人已加入") {
		t.Fatalf("joined footer missing: %v", plain)
	}

	join, ok := doc.buttonByText(t, "加入工作区")
	if !ok {
		t.Fatalf("join button missing: %v", doc.buttons(t))
	}
	if join["type"] != "primary" || join["disabled"] != false {
		t.Fatalf("join button must be an enabled primary button: %v", join)
	}
	behavior := behaviorOf(t, join)
	if behavior["type"] != "callback" {
		t.Fatalf("join behavior type = %v", behavior["type"])
	}
	value, ok := behavior["value"].(map[string]any)
	if !ok || value["action"] != larkInviteActionJoin || value["invite_id"] != "inv-1" {
		t.Fatalf("join callback value = %v", behavior["value"])
	}

	if _, ok := doc.buttonByText(t, "下载 Marvis"); ok {
		t.Fatalf("download button must be absent when DownloadURL is empty")
	}
}

func TestBuildLarkInviteCard_OmitsJoinedFooterWhenZero(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.JoinedCount = 0

	raw, err := buildLarkInviteCard(view)
	if err != nil {
		t.Fatalf("buildLarkInviteCard: %v", err)
	}
	doc := parseLarkInviteCardForTest(t, raw)

	if anyContainsLarkText(doc.plainTexts(t), "人已加入") || anyContainsLarkText(doc.markdownContents(t), "人已加入") {
		t.Fatalf("joined footer must be hidden when count is 0: %s", raw)
	}
	if anyContainsLarkText(doc.plainTexts(t), "“") {
		t.Fatalf("empty note must not render quotes: %s", raw)
	}
}

func TestBuildLarkInviteCard_DownloadButton(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.DownloadURL = "https://example.com/download"

	raw, err := buildLarkInviteCard(view)
	if err != nil {
		t.Fatalf("buildLarkInviteCard: %v", err)
	}
	doc := parseLarkInviteCardForTest(t, raw)

	download, ok := doc.buttonByText(t, "下载 Marvis")
	if !ok {
		t.Fatalf("download button missing: %v", doc.buttons(t))
	}
	if download["type"] != "default" {
		t.Fatalf("download button type = %v, want default", download["type"])
	}
	behavior := behaviorOf(t, download)
	if behavior["type"] != "open_url" || behavior["default_url"] != "https://example.com/download" {
		t.Fatalf("download behavior = %v", behavior)
	}
}

func TestBuildLarkInviteCard_AgentSender(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.AgentName = "设计助手"

	raw, err := buildLarkInviteCard(view)
	if err != nil {
		t.Fatalf("buildLarkInviteCard: %v", err)
	}
	doc := parseLarkInviteCardForTest(t, raw)

	want := "**设计助手** 代 **林晓** 邀请你加入工作区 **Dev**"
	if !anyContainsLarkText(doc.markdownContents(t), want) {
		t.Fatalf("agent sentence %q missing: %v", want, doc.markdownContents(t))
	}
}

func TestBuildLarkInviteCard_AdminRole(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.Role = "admin"

	raw, err := buildLarkInviteCard(view)
	if err != nil {
		t.Fatalf("buildLarkInviteCard: %v", err)
	}
	doc := parseLarkInviteCardForTest(t, raw)

	if !anyContainsLarkText(doc.markdownContents(t), "管理员") {
		t.Fatalf("admin role label missing: %v", doc.markdownContents(t))
	}
}

func TestBuildLarkInviteCard_EscapesUserText(t *testing.T) {
	const hostileNote = "**x** <at id=all></at> [a](http://e)"

	view := newLarkInviteViewForTest()
	view.Note = hostileNote
	view.WorkspaceName = "Dev*Team_1"
	view.InviterName = "<at id=all></at>"

	raw, err := buildLarkInviteCard(view)
	if err != nil {
		t.Fatalf("buildLarkInviteCard: %v", err)
	}
	doc := parseLarkInviteCardForTest(t, raw)

	// 附言只能出现在 plain_text 元素里，不能进入任何 markdown 元素。
	if !anyContainsLarkText(doc.plainTexts(t), hostileNote) {
		t.Fatalf("note must be rendered as plain_text: %v", doc.plainTexts(t))
	}
	for _, md := range doc.markdownContents(t) {
		for _, fragment := range []string{"<at id=all>", "[a](http://e)", "**x**", "http://e"} {
			if strings.Contains(md, fragment) {
				t.Fatalf("markdown element %q must not contain user text %q", md, fragment)
			}
		}
	}

	// 固定句式里插入的值必须转义。
	wantSentence := `**\<at id=all\>\</at\>** 邀请你加入工作区 **Dev\*Team\_1**`
	if !anyContainsLarkText(doc.markdownContents(t), wantSentence) {
		t.Fatalf("escaped sentence %q missing: %v", wantSentence, doc.markdownContents(t))
	}
	for _, md := range doc.markdownContents(t) {
		if strings.Contains(md, "Dev*Team_1") {
			t.Fatalf("markdown element must not contain the raw workspace name: %q", md)
		}
	}
}

func TestBuildLarkInviteCard_EscapeMarkdown(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain", in: "Dev 工作区", want: "Dev 工作区"},
		{name: "asterisk", in: "a*b", want: `a\*b`},
		{name: "underscore", in: "a_b", want: `a\_b`},
		{name: "brackets", in: "[a]", want: `\[a\]`},
		{name: "angle", in: "<at>", want: `\<at\>`},
		{name: "backtick", in: "`x`", want: "\\`x\\`"},
		{name: "backslash", in: `a\`, want: `a\\`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := escapeLarkInviteMarkdown(tt.in); got != tt.want {
				t.Fatalf("escapeLarkInviteMarkdown(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestBuildLarkInviteCard_InvalidAndJoined(t *testing.T) {
	t.Run("invalid", func(t *testing.T) {
		view := newLarkInviteViewForTest()
		view.State = larkInviteCardInvalid
		view.InvalidReason = "10 月 20 日已过期"

		raw, err := buildLarkInviteCard(view)
		if err != nil {
			t.Fatalf("buildLarkInviteCard: %v", err)
		}
		doc := parseLarkInviteCardForTest(t, raw)

		if got := doc.title(t); got != "邀请已失效" {
			t.Fatalf("title = %q", got)
		}
		if got := doc.header(t)["template"]; got != "grey" {
			t.Fatalf("template = %v, want grey", got)
		}
		join, ok := doc.buttonByText(t, "加入工作区")
		if !ok {
			t.Fatalf("invalid card keeps a disabled join button: %v", doc.buttons(t))
		}
		if join["disabled"] != true {
			t.Fatalf("join button must be disabled: %v", join)
		}
		if !anyContainsLarkText(doc.plainTexts(t), "10 月 20 日已过期") {
			t.Fatalf("invalid reason missing: %v", doc.plainTexts(t))
		}
	})

	t.Run("joined", func(t *testing.T) {
		view := newLarkInviteViewForTest()
		view.State = larkInviteCardJoined

		raw, err := buildLarkInviteCard(view)
		if err != nil {
			t.Fatalf("buildLarkInviteCard: %v", err)
		}
		doc := parseLarkInviteCardForTest(t, raw)

		if got := doc.title(t); got != "已加入 Dev" {
			t.Fatalf("title = %q", got)
		}
		if got := doc.header(t)["template"]; got != "green" {
			t.Fatalf("template = %v, want green", got)
		}
		if _, ok := doc.buttonByText(t, "加入工作区"); ok {
			t.Fatalf("joined card must not have a join button: %v", doc.buttons(t))
		}
		if !anyContainsLarkText(doc.markdownContents(t), "打开 Marvis，用飞书登录即可使用。") {
			t.Fatalf("joined body missing: %v", doc.markdownContents(t))
		}
	})

	t.Run("joined keeps download button", func(t *testing.T) {
		view := newLarkInviteViewForTest()
		view.State = larkInviteCardJoined
		view.DownloadURL = "https://example.com/download"

		raw, err := buildLarkInviteCard(view)
		if err != nil {
			t.Fatalf("buildLarkInviteCard: %v", err)
		}
		doc := parseLarkInviteCardForTest(t, raw)

		if _, ok := doc.buttonByText(t, "下载 Marvis"); !ok {
			t.Fatalf("joined card should keep the download button: %v", doc.buttons(t))
		}
	})
}

func TestBuildLarkInviteCard_UnknownState(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.State = larkInviteCardState("bogus")

	if _, err := buildLarkInviteCard(view); err == nil {
		t.Fatalf("expected an error for an unknown card state")
	}
}

func TestBuildLarkInviteCard_FormatDate(t *testing.T) {
	got := formatLarkInviteDate(time.Date(2026, time.January, 2, 23, 0, 0, 0, time.Local))
	if got != "1 月 2 日" {
		t.Fatalf("formatLarkInviteDate = %q, want %q", got, "1 月 2 日")
	}

	// 非本地时区的时间按服务器本地时区换算。
	utc := time.Date(2026, time.December, 31, 12, 0, 0, 0, time.UTC)
	want := utc.In(time.Local).Format("1 月 2 日")
	if got := formatLarkInviteDate(utc); got != want {
		t.Fatalf("formatLarkInviteDate(utc) = %q, want %q", got, want)
	}
}

func TestBuildLarkInviteCardToast(t *testing.T) {
	var got struct {
		Toast struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		} `json:"toast"`
		Card json.RawMessage `json:"card"`
	}
	if err := json.Unmarshal(buildLarkInviteToast(larkInviteToastError, `邀请"已失效"`), &got); err != nil {
		t.Fatalf("toast is not valid JSON: %v", err)
	}

	if got.Toast.Type != larkInviteToastError || got.Toast.Content != `邀请"已失效"` {
		t.Fatalf("toast = %+v", got.Toast)
	}
	if got.Card != nil {
		t.Fatalf("toast-only response must not carry a card: %s", got.Card)
	}
}

func TestBuildLarkInviteCardResponse(t *testing.T) {
	card, err := buildLarkInviteCard(newLarkInviteViewForTest())
	if err != nil {
		t.Fatalf("buildLarkInviteCard: %v", err)
	}

	var got struct {
		Toast struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		} `json:"toast"`
		Card struct {
			Type string         `json:"type"`
			Data map[string]any `json:"data"`
		} `json:"card"`
	}
	body, err := buildLarkInviteCardResponse(larkInviteToastSuccess, "已加入", card)
	if err != nil {
		t.Fatalf("buildLarkInviteCardResponse: %v", err)
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}

	if got.Toast.Type != larkInviteToastSuccess || got.Toast.Content != "已加入" {
		t.Fatalf("toast = %+v", got.Toast)
	}
	if got.Card.Type != "raw" {
		t.Fatalf("card.type = %q, want raw", got.Card.Type)
	}
	// data 必须是对象，而不是被二次编码的字符串。
	if got.Card.Data["schema"] != "2.0" {
		t.Fatalf("card.data must embed the card object, got %v", got.Card.Data)
	}
}

func TestBuildLarkInviteCardResponse_InvalidCard(t *testing.T) {
	for name, card := range map[string]string{
		"not json":  "not json",
		"empty":     "",
		"truncated": `{"schema":"2.0"`,
	} {
		t.Run(name, func(t *testing.T) {
			body, err := buildLarkInviteCardResponse(larkInviteToastError, "失败", card)
			if err == nil {
				t.Fatalf("expected an error for an invalid card, got body %s", body)
			}
			if body != nil {
				t.Fatalf("body must be nil on error, got %s", body)
			}
		})
	}
}
