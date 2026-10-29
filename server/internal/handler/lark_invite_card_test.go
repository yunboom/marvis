package handler

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// larkCardDoc 是测试里解析卡片 JSON 用的通用结构。
type larkCardDoc map[string]any

// 测试用的卡片链接。
const (
	testLarkInviteLandingURL  = "https://example.com/marvis"
	testLarkInviteLoginURL    = "https://example.com/marvis/login?next=%2Fdev%2Fissues"
	testLarkInviteDownloadURL = "https://example.com/download"
)

// parseLarkInviteCardForTest 解析 buildLarkInviteCard 的输出。
func parseLarkInviteCardForTest(t *testing.T, raw string) larkCardDoc {
	t.Helper()

	var doc larkCardDoc
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("card is not valid JSON: %v\n%s", err, raw)
	}

	return doc
}

// buildLarkInviteDocForTest 生成卡片并解析。
func buildLarkInviteDocForTest(t *testing.T, view larkInviteCardView) (larkCardDoc, string) {
	t.Helper()

	raw, err := buildLarkInviteCard(view)
	if err != nil {
		t.Fatalf("buildLarkInviteCard: %v", err)
	}

	return parseLarkInviteCardForTest(t, raw), raw
}

// asLarkObjects 把 JSON 数组转成对象切片，不是数组时返回空。
func asLarkObjects(v any) []map[string]any {
	items, _ := v.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}

	return out
}

// topElements 返回 body.elements。
func (d larkCardDoc) topElements(t *testing.T) []map[string]any {
	t.Helper()

	body, ok := d["body"].(map[string]any)
	if !ok {
		t.Fatalf("card has no body: %v", d)
	}

	return asLarkObjects(body["elements"])
}

// allElements 递归返回正文里的全部元素：分栏里的列、列和容器里的子元素都展开。
func (d larkCardDoc) allElements(t *testing.T) []map[string]any {
	t.Helper()

	var out []map[string]any
	var walk func(elements []map[string]any)
	walk = func(elements []map[string]any) {
		for _, element := range elements {
			out = append(out, element)
			for _, column := range asLarkObjects(element["columns"]) {
				out = append(out, column)
				walk(asLarkObjects(column["elements"]))
			}
			walk(asLarkObjects(element["elements"]))
		}
	}
	walk(d.topElements(t))

	return out
}

// textOf 返回 div 元素的 text 对象。
func textOf(element map[string]any) map[string]any {
	text, _ := element["text"].(map[string]any)

	return text
}

// markdownContents 返回所有 markdown 元素的 content。
func (d larkCardDoc) markdownContents(t *testing.T) []string {
	t.Helper()

	var out []string
	for _, element := range d.allElements(t) {
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
	for _, element := range d.allElements(t) {
		text := textOf(element)
		if element["tag"] != "div" || text["tag"] != "plain_text" {
			continue
		}
		content, _ := text["content"].(string)
		out = append(out, content)
	}

	return out
}

// textElement 按内容查找 plain_text 的 text 对象。
func (d larkCardDoc) textElement(t *testing.T, content string) (map[string]any, bool) {
	t.Helper()

	for _, element := range d.allElements(t) {
		if text := textOf(element); element["tag"] == "div" && text["content"] == content {
			return text, true
		}
	}

	return nil, false
}

// pills 返回所有通栏的 interactive_container（胶囊按钮）。
func (d larkCardDoc) pills(t *testing.T) []map[string]any {
	t.Helper()

	var out []map[string]any
	for _, element := range d.topElements(t) {
		if element["tag"] == "interactive_container" {
			out = append(out, element)
		}
	}

	return out
}

// pillByText 按按钮文案查找胶囊按钮。
func (d larkCardDoc) pillByText(t *testing.T, text string) (map[string]any, bool) {
	t.Helper()

	for _, pill := range d.pills(t) {
		for _, child := range asLarkObjects(pill["elements"]) {
			if textOf(child)["content"] == text {
				return pill, true
			}
		}
	}

	return nil, false
}

// titleRow 返回标题行（第一个元素）的各列。
func (d larkCardDoc) titleRow(t *testing.T) []map[string]any {
	t.Helper()

	elements := d.topElements(t)
	if len(elements) == 0 || elements[0]["tag"] != "column_set" {
		t.Fatalf("first element is not the title row: %v", elements)
	}
	columns := asLarkObjects(elements[0]["columns"])
	if len(columns) < 2 {
		t.Fatalf("title row has %d columns, want at least 2", len(columns))
	}

	return columns
}

// title 返回标题行的标题 text 对象。
func (d larkCardDoc) title(t *testing.T) map[string]any {
	t.Helper()

	children := asLarkObjects(d.titleRow(t)[1]["elements"])
	if len(children) < 2 {
		t.Fatalf("title column needs title and subtitle: %v", children)
	}

	return textOf(children[0])
}

// subtitle 返回标题行的副标题。
func (d larkCardDoc) subtitle(t *testing.T) string {
	t.Helper()

	children := asLarkObjects(d.titleRow(t)[1]["elements"])
	content, _ := textOf(children[1])["content"].(string)

	return content
}

// status 返回标题行右侧的状态 text 对象，没有状态时为 nil。
func (d larkCardDoc) status(t *testing.T) map[string]any {
	t.Helper()

	columns := d.titleRow(t)
	if len(columns) < 3 {
		return nil
	}
	children := asLarkObjects(columns[2]["elements"])
	if len(children) == 0 {
		t.Fatalf("status column is empty: %v", columns[2])
	}

	return textOf(children[0])
}

// personLists 返回所有 person_list 元素。
func (d larkCardDoc) personLists(t *testing.T) []map[string]any {
	t.Helper()

	var out []map[string]any
	for _, element := range d.allElements(t) {
		if element["tag"] == "person_list" {
			out = append(out, element)
		}
	}

	return out
}

// behaviorOf 返回容器的第一个 behavior。
func behaviorOf(t *testing.T, element map[string]any) map[string]any {
	t.Helper()

	behaviors := asLarkObjects(element["behaviors"])
	if len(behaviors) == 0 {
		t.Fatalf("element has no behaviors: %v", element)
	}

	return behaviors[0]
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

// newLarkInviteViewForTest 返回一张邀请中的群卡片：人数不限、3 人已加入、链接齐全。
func newLarkInviteViewForTest() larkInviteCardView {
	return larkInviteCardView{
		State:         larkInviteCardActive,
		InviteID:      "inv-1",
		WorkspaceName: "Dev",
		InviterName:   "林晓",
		Role:          "member",
		// 北京时间 10 月 30 日 09:30。
		ExpiresAt:     time.Date(2026, time.October, 30, 1, 30, 0, 0, time.UTC),
		IsGroup:       true,
		JoinedCount:   3,
		JoinedOpenIDs: []string{"ou_a", "ou_b", "ou_c"},
		Links: larkInviteCardLinks{
			Landing:  testLarkInviteLandingURL,
			Download: testLarkInviteDownloadURL,
			Login:    testLarkInviteLoginURL,
		},
	}
}

// assertLarkInviteJoinCallback 断言主按钮回传的是加入动作和邀请 ID，点击处理依赖这两个字段。
func assertLarkInviteJoinCallback(t *testing.T, join map[string]any) {
	t.Helper()

	behavior := behaviorOf(t, join)
	if behavior["type"] != "callback" {
		t.Fatalf("join behavior type = %v, want callback", behavior["type"])
	}
	value, ok := behavior["value"].(map[string]any)
	if !ok || len(value) != 2 || value["action"] != larkInviteActionJoin || value["invite_id"] != "inv-1" {
		t.Fatalf("join callback value = %v", behavior["value"])
	}
}

func TestBuildLarkInviteCard_NoHeaderAndThemeConfig(t *testing.T) {
	wantColors := map[string]any{
		"ink":    map[string]any{"light_mode": "rgba(15,15,15,1)", "dark_mode": "rgba(240,240,240,1)"},
		"on-ink": map[string]any{"light_mode": "rgba(255,255,255,1)", "dark_mode": "rgba(15,15,15,1)"},
		"faint":  map[string]any{"light_mode": "rgba(136,136,136,1)", "dark_mode": "rgba(150,150,150,1)"},
		"block":  map[string]any{"light_mode": "rgba(247,247,247,1)", "dark_mode": "rgba(255,255,255,0.06)"},
		"line":   map[string]any{"light_mode": "rgba(227,227,227,1)", "dark_mode": "rgba(255,255,255,0.16)"},
	}

	for _, state := range []larkInviteCardState{larkInviteCardActive, larkInviteCardInvalid, larkInviteCardJoined} {
		t.Run(string(state), func(t *testing.T) {
			view := newLarkInviteViewForTest()
			view.State = state
			doc, _ := buildLarkInviteDocForTest(t, view)

			if doc["schema"] != "2.0" {
				t.Fatalf("schema = %v, want 2.0", doc["schema"])
			}
			if _, ok := doc["header"]; ok {
				t.Fatalf("card must not have a header: %v", doc["header"])
			}

			config, _ := doc["config"].(map[string]any)
			if config["update_multi"] != true || config["width_mode"] != "compact" {
				t.Fatalf("config = %v, want update_multi and compact width", config)
			}
			summary, _ := config["summary"].(map[string]any)
			if summary["content"] != "林晓 邀请你加入 Dev" {
				t.Fatalf("summary = %v", config["summary"])
			}
			style, _ := config["style"].(map[string]any)
			if !reflect.DeepEqual(style["color"], wantColors) {
				t.Fatalf("style.color = %v, want %v", style["color"], wantColors)
			}

			body, _ := doc["body"].(map[string]any)
			if body["padding"] != "18px 18px 18px 18px" || body["vertical_spacing"] != "12px" {
				t.Fatalf("body layout = %v", body)
			}
		})
	}
}

func TestBuildLarkInviteCard_ActiveGroup(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.Note = "周会前看一下看板"
	doc, _ := buildLarkInviteDocForTest(t, view)

	title := doc.title(t)
	if title["tag"] != "plain_text" || title["content"] != "加入 Dev" || title["text_size"] != "heading-4" {
		t.Fatalf("title = %v, want plain_text heading 加入 Dev", title)
	}
	if got := doc.subtitle(t); got != "林晓 邀请 · Marvis Workbench" {
		t.Fatalf("subtitle = %q", got)
	}
	if doc.status(t) != nil {
		t.Fatalf("active card has no status: %v", doc.status(t))
	}

	// logo 是 ink 底色的圆角容器，点开首页。
	logo := asLarkObjects(doc.titleRow(t)[0]["elements"])
	if len(logo) != 1 || logo[0]["tag"] != "interactive_container" || logo[0]["background_style"] != "ink" {
		t.Fatalf("logo = %v, want an ink interactive_container", logo)
	}
	if b := behaviorOf(t, logo[0]); b["type"] != "open_url" || b["default_url"] != testLarkInviteLandingURL {
		t.Fatalf("logo behavior = %v", b)
	}

	elements := doc.topElements(t)
	if elements[1]["tag"] != "column_set" || elements[1]["background_style"] != "block" {
		t.Fatalf("note block = %v, want a block-colored column_set", elements[1])
	}
	if !anyContainsLarkText(doc.plainTexts(t), "周会前看一下看板") {
		t.Fatalf("note missing from plain_text: %v", doc.plainTexts(t))
	}

	meta := doc.markdownContents(t)
	if len(meta) != 1 {
		t.Fatalf("markdown elements = %v, want only the meta line", meta)
	}
	for _, want := range []string{"角色", "**成员**", "10 月 30 日 09:30 前有效", "人数不限"} {
		if !strings.Contains(meta[0], want) {
			t.Fatalf("meta %q missing %q", meta[0], want)
		}
	}

	join, ok := doc.pillByText(t, "加入工作区")
	if !ok {
		t.Fatalf("join pill missing: %v", doc.pills(t))
	}
	if join["background_style"] != "ink" || join["disabled"] != nil || join["corner_radius"] != "20px" {
		t.Fatalf("join pill = %v, want enabled ink pill", join)
	}
	assertLarkInviteJoinCallback(t, join)

	learn, ok := doc.pillByText(t, "了解 Marvis")
	if !ok {
		t.Fatalf("learn pill missing: %v", doc.pills(t))
	}
	if learn["has_border"] != true || learn["border_color"] != "line" {
		t.Fatalf("learn pill = %v, want outlined", learn)
	}
	if b := behaviorOf(t, learn); b["type"] != "open_url" || b["default_url"] != testLarkInviteLandingURL {
		t.Fatalf("learn behavior = %v", b)
	}
	if _, ok := doc.pillByText(t, "下载 Marvis"); ok {
		t.Fatal("download pill is replaced by 了解 Marvis when the landing URL is set")
	}

	lists := doc.personLists(t)
	if len(lists) != 1 {
		t.Fatalf("person_list count = %d, want 1", len(lists))
	}
	pl := lists[0]
	if pl["show_avatar"] != true || pl["show_name"] != false || pl["size"] != "extra_small" || pl["drop_invalid_user_id"] != true {
		t.Fatalf("person_list = %v", pl)
	}
	if persons := asLarkObjects(pl["persons"]); len(persons) != 3 || persons[0]["id"] != "ou_a" {
		t.Fatalf("persons = %v", pl["persons"])
	}
	if !anyContainsLarkText(doc.plainTexts(t), "3 人已加入") {
		t.Fatalf("joined count missing: %v", doc.plainTexts(t))
	}
}

func TestBuildLarkInviteCard_JoinedRow(t *testing.T) {
	cases := []struct {
		name        string
		isGroup     bool
		count       int
		ids         []string
		wantRow     bool
		wantPersons int
	}{
		{name: "avatars capped at five", isGroup: true, count: 7, ids: []string{"ou_1", "ou_2", "ou_3", "ou_4", "ou_5", "ou_6", "ou_7"}, wantRow: true, wantPersons: 5},
		{name: "no open ids falls back to count only", isGroup: true, count: 3, wantRow: true},
		{name: "zero joined hides the row", isGroup: true, count: 0},
		{name: "personal card has no row", count: 1, ids: []string{"ou_1"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			view := newLarkInviteViewForTest()
			view.IsGroup = tc.isGroup
			view.JoinedCount = tc.count
			view.JoinedOpenIDs = tc.ids
			doc, raw := buildLarkInviteDocForTest(t, view)

			if got := strings.Contains(raw, "人已加入"); got != tc.wantRow {
				t.Fatalf("joined row shown = %v, want %v: %s", got, tc.wantRow, raw)
			}
			lists := doc.personLists(t)
			if tc.wantPersons == 0 {
				if len(lists) != 0 {
					t.Fatalf("person_list = %v, want none", lists)
				}
				return
			}
			if len(lists) != 1 || len(asLarkObjects(lists[0]["persons"])) != tc.wantPersons {
				t.Fatalf("person_list = %v, want %d persons", lists, tc.wantPersons)
			}
		})
	}
}

func TestBuildLarkInviteCard_MetaHeadcount(t *testing.T) {
	cases := []struct {
		name    string
		isGroup bool
		maxUses int
		want    string
		absent  []string
	}{
		{name: "group unlimited", isGroup: true, want: "人数不限"},
		{name: "group capped", isGroup: true, maxUses: 10, want: "最多 10 人", absent: []string{"人数不限"}},
		{name: "personal", want: "前有效", absent: []string{"人数不限", "最多"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			view := newLarkInviteViewForTest()
			view.IsGroup = tc.isGroup
			view.MaxUses = tc.maxUses
			doc, _ := buildLarkInviteDocForTest(t, view)

			meta := doc.markdownContents(t)
			if !anyContainsLarkText(meta, tc.want) {
				t.Fatalf("meta %v missing %q", meta, tc.want)
			}
			for _, s := range tc.absent {
				if anyContainsLarkText(meta, s) {
					t.Fatalf("meta %v must not contain %q", meta, s)
				}
			}
		})
	}
}

func TestBuildLarkInviteCard_AdminRole(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.Role = "admin"
	doc, _ := buildLarkInviteDocForTest(t, view)

	if !anyContainsLarkText(doc.markdownContents(t), "**管理员**") {
		t.Fatalf("admin role label missing: %v", doc.markdownContents(t))
	}
}

// TestBuildLarkInviteCard_Senders 覆盖副标题和 summary 的署名：智能体代发、发送人已删除、都已删除。
func TestBuildLarkInviteCard_Senders(t *testing.T) {
	cases := []struct {
		name         string
		inviter      string
		agent        string
		wantSubtitle string
		wantSummary  string
	}{
		{name: "agent on behalf of inviter", inviter: "林晓", agent: "设计助手", wantSubtitle: "设计助手 代 林晓 邀请 · Marvis Workbench", wantSummary: "设计助手 代 林晓 邀请你加入 Dev"},
		{name: "agent without inviter", agent: "设计助手", wantSubtitle: "设计助手 邀请 · Marvis Workbench", wantSummary: "设计助手 邀请你加入 Dev"},
		{name: "no sender", wantSubtitle: "Marvis Workbench", wantSummary: "邀请你加入 Dev"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			view := newLarkInviteViewForTest()
			view.InviterName = tc.inviter
			view.AgentName = tc.agent
			doc, _ := buildLarkInviteDocForTest(t, view)

			if got := doc.subtitle(t); got != tc.wantSubtitle {
				t.Fatalf("subtitle = %q, want %q", got, tc.wantSubtitle)
			}
			config, _ := doc["config"].(map[string]any)
			summary, _ := config["summary"].(map[string]any)
			if summary["content"] != tc.wantSummary {
				t.Fatalf("summary = %v, want %q", summary["content"], tc.wantSummary)
			}
		})
	}
}

func TestBuildLarkInviteCard_EscapesUserText(t *testing.T) {
	const hostileNote = "**x** <at id=all></at> [a](http://e)"

	for _, state := range []larkInviteCardState{larkInviteCardActive, larkInviteCardInvalid, larkInviteCardJoined} {
		t.Run(string(state), func(t *testing.T) {
			view := newLarkInviteViewForTest()
			view.State = state
			view.Note = hostileNote
			view.WorkspaceName = "Dev*Team_1"
			view.InviterName = "<at id=all></at>"
			view.AgentName = "<at id=all></at>"
			doc, _ := buildLarkInviteDocForTest(t, view)

			// 附言、发送人名、智能体名、工作区名都只能出现在 plain_text 元素里，不能进入任何 markdown 元素。
			if state == larkInviteCardActive {
				if !anyContainsLarkText(doc.plainTexts(t), hostileNote) {
					t.Fatalf("note must be rendered as plain_text: %v", doc.plainTexts(t))
				}
				if got := doc.title(t)["content"]; got != "加入 Dev*Team_1" {
					t.Fatalf("title = %v, want the workspace name verbatim", got)
				}
			}
			for _, md := range doc.markdownContents(t) {
				for _, fragment := range []string{"<at", "[a](http://e)", "**x**", "http://e", "Dev", "Team"} {
					if strings.Contains(md, fragment) {
						t.Fatalf("markdown element %q must not contain user text %q", md, fragment)
					}
				}
			}
		})
	}
}

func TestBuildLarkInviteCard_EscapeMarkdown(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain", in: "成员", want: "成员"},
		{name: "ampersand", in: "a&b", want: "a&amp;b"},
		{name: "angle", in: "<at id=all></at>", want: "&lt;at id=all&gt;&lt;/at&gt;"},
		{name: "entity is not decoded", in: "&lt;", want: "&amp;lt;"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := escapeLarkInviteMarkdown(tt.in); got != tt.want {
				t.Fatalf("escapeLarkInviteMarkdown(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestBuildLarkInviteCard_Invalid(t *testing.T) {
	cases := []struct {
		status     string
		reason     string
		wantStatus string
	}{
		{status: larkInviteStatusExpired, reason: "10 月 20 日 18:00 已过期", wantStatus: "已过期"},
		{status: larkInviteStatusRevoked, reason: larkInviteReasonRevoked, wantStatus: "已撤销"},
	}

	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			view := newLarkInviteViewForTest()
			view.State = larkInviteCardInvalid
			view.InvalidStatus = tc.status
			view.InvalidReason = tc.reason
			view.Note = "欢迎加入"
			doc, raw := buildLarkInviteDocForTest(t, view)

			title := doc.title(t)
			if title["content"] != "邀请已失效" || title["text_color"] != "faint" {
				t.Fatalf("title = %v, want faint 邀请已失效", title)
			}
			if status := doc.status(t); status["content"] != tc.wantStatus || status["text_color"] != "faint" {
				t.Fatalf("status = %v, want faint %s", status, tc.wantStatus)
			}
			logo := asLarkObjects(doc.titleRow(t)[0]["elements"])
			if len(logo) != 1 || logo[0]["background_style"] != "faint" {
				t.Fatalf("logo = %v, want faint background", logo)
			}
			if note, ok := doc.textElement(t, "欢迎加入"); !ok || note["text_color"] != "faint" {
				t.Fatalf("note = %v, want faint", note)
			}
			if meta := doc.markdownContents(t); len(meta) != 1 || strings.Contains(meta[0], "**") {
				t.Fatalf("invalid meta = %v, want one non-bold line", meta)
			}

			join, ok := doc.pillByText(t, "加入工作区")
			if !ok {
				t.Fatalf("invalid card keeps a disabled join pill: %v", doc.pills(t))
			}
			if join["disabled"] != true || join["background_style"] != "line" {
				t.Fatalf("join pill = %v, want disabled with line background", join)
			}
			assertLarkInviteJoinCallback(t, join)

			if !anyContainsLarkText(doc.plainTexts(t), tc.reason) {
				t.Fatalf("invalid reason missing: %v", doc.plainTexts(t))
			}
			if strings.Contains(raw, "人已加入") || len(doc.personLists(t)) != 0 {
				t.Fatalf("invalid card must not show the joined row: %s", raw)
			}
		})
	}
}

func TestBuildLarkInviteCard_Joined(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.State = larkInviteCardJoined
	view.IsGroup = false
	view.Note = "欢迎加入"
	doc, raw := buildLarkInviteDocForTest(t, view)

	if got := doc.title(t)["content"]; got != "已加入 Dev" {
		t.Fatalf("title = %v", got)
	}
	if got := doc.subtitle(t); got != "Marvis Workbench" {
		t.Fatalf("subtitle = %q", got)
	}
	if status := doc.status(t); status["content"] != "已加入" || status["text_color"] != "green" {
		t.Fatalf("status = %v, want green 已加入", status)
	}
	if !anyContainsLarkText(doc.plainTexts(t), "打开 Marvis，用飞书登录即可使用。") {
		t.Fatalf("joined body missing: %v", doc.plainTexts(t))
	}
	if strings.Contains(raw, "欢迎加入") || len(doc.markdownContents(t)) != 0 {
		t.Fatalf("joined card has no note or meta: %s", raw)
	}
	if _, ok := doc.pillByText(t, "加入工作区"); ok {
		t.Fatal("joined card must not have a join pill")
	}

	open, ok := doc.pillByText(t, "打开 Marvis")
	if !ok {
		t.Fatalf("open pill missing: %v", doc.pills(t))
	}
	if b := behaviorOf(t, open); b["type"] != "open_url" || b["default_url"] != testLarkInviteLoginURL || open["background_style"] != "ink" {
		t.Fatalf("open pill = %v", open)
	}
	if _, ok := doc.pillByText(t, "了解 Marvis"); !ok {
		t.Fatalf("joined card keeps the secondary pill: %v", doc.pills(t))
	}

	t.Run("without login url", func(t *testing.T) {
		view.Links.Login = ""
		doc, _ := buildLarkInviteDocForTest(t, view)

		if _, ok := doc.pillByText(t, "打开 Marvis"); ok {
			t.Fatal("open pill must be omitted without a login URL")
		}
	})
}

// TestBuildLarkInviteCard_LinkFallbacks 覆盖没有首页地址时 logo 不可点击、次按钮退回下载，两个地址都没有时不显示次按钮。
func TestBuildLarkInviteCard_LinkFallbacks(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.Links.Landing = ""
	doc, raw := buildLarkInviteDocForTest(t, view)

	logoColumn := doc.titleRow(t)[0]
	logo := asLarkObjects(logoColumn["elements"])
	if logoColumn["background_style"] != "ink" || len(logo) != 1 || logo[0]["tag"] != "div" {
		t.Fatalf("logo column = %v, want a plain ink column", logoColumn)
	}
	if strings.Contains(raw, testLarkInviteLandingURL) {
		t.Fatalf("card links to the landing page without a landing URL: %s", raw)
	}

	download, ok := doc.pillByText(t, "下载 Marvis")
	if !ok {
		t.Fatalf("download pill missing: %v", doc.pills(t))
	}
	if b := behaviorOf(t, download); b["type"] != "open_url" || b["default_url"] != testLarkInviteDownloadURL {
		t.Fatalf("download behavior = %v", b)
	}

	view.Links.Download = ""
	doc, _ = buildLarkInviteDocForTest(t, view)
	if pills := doc.pills(t); len(pills) != 1 {
		t.Fatalf("pills = %v, want only the join pill", pills)
	}
}

func TestNewLarkInviteCardLinks(t *testing.T) {
	cases := []struct {
		name   string
		appURL string
		slug   string
		want   larkInviteCardLinks
	}{
		{
			name:   "path prefix",
			appURL: "https://example.com/marvis/",
			slug:   "dev",
			want:   larkInviteCardLinks{Landing: testLarkInviteLandingURL, Download: testLarkInviteDownloadURL, Login: testLarkInviteLoginURL},
		},
		{name: "no workspace slug", appURL: "https://example.com", want: larkInviteCardLinks{Landing: "https://example.com", Download: testLarkInviteDownloadURL}},
		{name: "unset", slug: "dev", want: larkInviteCardLinks{Download: testLarkInviteDownloadURL}},
		{name: "localhost", appURL: "http://localhost:3000", slug: "dev", want: larkInviteCardLinks{Download: testLarkInviteDownloadURL}},
		{name: "loopback ip", appURL: "http://127.0.0.1:3000", slug: "dev", want: larkInviteCardLinks{Download: testLarkInviteDownloadURL}},
		{name: "not http", appURL: "marvis://open", slug: "dev", want: larkInviteCardLinks{Download: testLarkInviteDownloadURL}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := newLarkInviteCardLinks(tc.appURL, testLarkInviteDownloadURL, tc.slug); got != tc.want {
				t.Fatalf("links = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestBuildLarkInviteCard_UnknownState(t *testing.T) {
	view := newLarkInviteViewForTest()
	view.State = larkInviteCardState("bogus")

	if _, err := buildLarkInviteCard(view); err == nil {
		t.Fatalf("expected an error for an unknown card state")
	}
}

func TestBuildLarkInviteCard_FormatDate(t *testing.T) {
	// 卡片日期固定按北京时间显示到时分，与服务器所在时区无关。
	cases := []struct {
		name string
		in   time.Time
		want string
	}{
		{name: "utc afternoon", in: time.Date(2026, time.January, 2, 7, 4, 0, 0, time.UTC), want: "1 月 2 日 15:04"},
		{name: "utc evening rolls over to the next day", in: time.Date(2025, time.December, 31, 16, 30, 0, 0, time.UTC), want: "1 月 1 日 00:30"},
		{name: "other zone", in: time.Date(2026, time.October, 23, 20, 0, 0, 0, time.FixedZone("UTC-5", -5*3600)), want: "10 月 24 日 09:00"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatLarkInviteDate(tc.in); got != tc.want {
				t.Fatalf("formatLarkInviteDate(%s) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestLarkInviteLocation_FallsBackToFixedOffset(t *testing.T) {
	loc := larkInviteLocation(func(string) (*time.Location, error) {
		return nil, errors.New("unknown time zone Asia/Shanghai")
	})

	got := time.Date(2026, time.January, 2, 7, 4, 0, 0, time.UTC).In(loc)
	if name, offset := got.Zone(); name != "CST" || offset != 8*3600 {
		t.Fatalf("fallback zone = %s %d, want CST %d", name, offset, 8*3600)
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
