package handler

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// 本文件集中构造飞书邀请卡片（卡片 JSON 2.0）和卡片回调响应。
// 卡片 JSON 一律用结构体序列化，不拼字符串；用户提供的文本（附言、发送人名、智能体名、工作区名）
// 只放进 plain_text 元素。markdown 元素只承载固定文案，插入的角色名经 escapeLarkInviteMarkdown 转义。

// larkInviteActionJoin 是“加入工作区”按钮回传值里的 action。
const larkInviteActionJoin = "join_workspace"

// larkInviteCardState 是邀请卡片的展示状态。
type larkInviteCardState string

// 邀请卡片的展示状态。
const (
	larkInviteCardActive  larkInviteCardState = "active"
	larkInviteCardJoined  larkInviteCardState = "joined"
	larkInviteCardInvalid larkInviteCardState = "invalid"
)

// 卡片 JSON 2.0 的结构常量。
const (
	larkCardSchemaVersion = "2.0"

	larkCardTagPlainText = "plain_text"
	larkCardTagMarkdown  = "markdown"
	larkCardTagDiv       = "div"
	larkCardTagHR        = "hr"
	larkCardTagButton    = "button"

	larkCardButtonPrimary = "primary"
	larkCardButtonDefault = "default"

	larkCardBehaviorCallback = "callback"
	larkCardBehaviorOpenURL  = "open_url"

	larkCardTemplateBlue  = "blue"
	larkCardTemplateGrey  = "grey"
	larkCardTemplateGreen = "green"

	larkCardTextSizeNotation = "notation"
	larkCardTextColorGrey    = "grey"

	// larkCardResponseTypeRaw 表示回调响应里的卡片是原始卡片 JSON。
	larkCardResponseTypeRaw = "raw"
)

// 卡片回调响应里 toast 的类型。
const (
	larkInviteToastSuccess = "success"
	larkInviteToastError   = "error"
	larkInviteToastInfo    = "info"
	larkInviteToastWarning = "warning"
)

// 角色取值，与工作区成员角色一致。
const (
	larkInviteRoleMember = "member"
	larkInviteRoleAdmin  = "admin"
)

// 卡片产品文案。
const (
	larkInviteTitleActive  = "工作区邀请"
	larkInviteTitleInvalid = "邀请已失效"
	// larkInviteTitleJoinedFormat 的参数是工作区名。
	larkInviteTitleJoinedFormat = "已加入 %s"

	// larkInviteSentenceFormat 的参数依次是发送人、工作区名。正文句子以 plain_text 渲染，名字不加粗。
	larkInviteSentenceFormat = "%s 邀请你加入工作区 %s"
	// larkInviteAgentSentenceFormat 的参数依次是智能体名、发送人、工作区名。
	larkInviteAgentSentenceFormat = "%s 代 %s 邀请你加入工作区 %s"
	larkInviteJoinedBody          = "打开 Marvis，用飞书登录即可使用。"

	// larkInviteNoteFormat 的参数是附言，前后加中文引号。
	larkInviteNoteFormat = "“%s”"

	larkInviteFieldRole    = "角色"
	larkInviteFieldExpires = "有效期至"
	// larkInviteFieldFormat 的参数依次是字段名、字段值。
	larkInviteFieldFormat = "**%s**：%s"

	larkInviteRoleMemberLabel = "成员"
	larkInviteRoleAdminLabel  = "管理员"

	larkInviteButtonJoin     = "加入工作区"
	larkInviteButtonDownload = "下载 Marvis"

	// larkInviteJoinedCountFormat 的参数是已加入人数。
	larkInviteJoinedCountFormat = "%d 人已加入"
)

// 卡片日期的格式和时区。卡片只有中文，按北京时间显示到时分；自托管容器常跑在 UTC，不能用服务器本地时区。
const (
	// larkInviteDateLayout 是卡片日期的格式，例如“1 月 2 日 15:04”。
	larkInviteDateLayout = "1 月 2 日 15:04"
	// larkInviteTimeZone 是卡片日期的时区。
	larkInviteTimeZone = "Asia/Shanghai"
	// larkInviteFallbackZoneName、larkInviteFallbackZoneOffset 是加载不到时区数据时使用的固定东八区。
	larkInviteFallbackZoneName   = "CST"
	larkInviteFallbackZoneOffset = 8 * 60 * 60
)

// larkInviteCardLocation 是卡片日期的时区，进程启动时加载一次。
var larkInviteCardLocation = larkInviteLocation(time.LoadLocation)

// larkInviteCardView 是渲染邀请卡片所需的数据。
type larkInviteCardView struct {
	State         larkInviteCardState
	InviteID      string
	WorkspaceName string
	InviterName   string
	// AgentName 在智能体代发时非空。
	AgentName string
	Role      string
	Note      string
	ExpiresAt time.Time
	// JoinedCount 为 0 时不显示“已加入”人数。
	JoinedCount int
	// InvalidReason 是失效状态的底部说明，例如“10 月 20 日已过期”“已撤销”。
	InvalidReason string
	// DownloadURL 为空时不显示下载按钮。
	DownloadURL string
}

// larkCard 是卡片 JSON 2.0 的根对象。
type larkCard struct {
	Schema string         `json:"schema"`
	Config larkCardConfig `json:"config"`
	Header larkCardHeader `json:"header"`
	Body   larkCardBody   `json:"body"`
}

// larkCardConfig 是卡片全局配置。
type larkCardConfig struct {
	// UpdateMulti 为 true 时，卡片更新对所有接收人可见。
	UpdateMulti bool `json:"update_multi"`
}

// larkCardHeader 是卡片标题栏。
type larkCardHeader struct {
	Title    larkCardText `json:"title"`
	Template string       `json:"template"`
}

// larkCardBody 是卡片正文。
type larkCardBody struct {
	Elements []any `json:"elements"`
}

// larkCardText 是 plain_text 文本对象。
type larkCardText struct {
	Tag       string `json:"tag"`
	Content   string `json:"content"`
	TextSize  string `json:"text_size,omitempty"`
	TextColor string `json:"text_color,omitempty"`
}

// larkCardMarkdown 是 markdown 元素。
type larkCardMarkdown struct {
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

// larkCardDiv 是承载 plain_text 的 div 元素。
type larkCardDiv struct {
	Tag  string       `json:"tag"`
	Text larkCardText `json:"text"`
}

// larkCardHRElement 是分割线元素。
type larkCardHRElement struct {
	Tag string `json:"tag"`
}

// larkCardButton 是按钮元素。
type larkCardButton struct {
	Tag       string             `json:"tag"`
	Text      larkCardText       `json:"text"`
	Type      string             `json:"type"`
	Disabled  bool               `json:"disabled"`
	Behaviors []larkCardBehavior `json:"behaviors"`
}

// larkCardBehavior 是按钮点击行为：回调或打开链接。
type larkCardBehavior struct {
	Type       string                  `json:"type"`
	Value      *larkInviteCallbackData `json:"value,omitempty"`
	DefaultURL string                  `json:"default_url,omitempty"`
}

// larkInviteCallbackData 是“加入工作区”按钮的回传值。
type larkInviteCallbackData struct {
	Action   string `json:"action"`
	InviteID string `json:"invite_id"`
}

// larkInviteToast 是卡片回调响应里的 toast。
type larkInviteToast struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// larkInviteCallbackResponse 是卡片回调响应，Card 为空时只提示不更新卡片。
type larkInviteCallbackResponse struct {
	Toast larkInviteToast         `json:"toast"`
	Card  *larkInviteCardResponse `json:"card,omitempty"`
}

// larkInviteCardResponse 是回调响应里的卡片，Data 是卡片对象而不是字符串。
type larkInviteCardResponse struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// buildLarkInviteCard 按展示状态生成邀请卡片 JSON（schema 2.0，config.update_multi=true）。
func buildLarkInviteCard(v larkInviteCardView) (string, error) {
	card := larkCard{
		Schema: larkCardSchemaVersion,
		Config: larkCardConfig{UpdateMulti: true},
	}

	switch v.State {
	case larkInviteCardActive:
		card.Header = larkInviteHeader(larkInviteTitleActive, larkCardTemplateBlue)
		card.Body.Elements = larkInviteOpenElements(v, false)
	case larkInviteCardInvalid:
		card.Header = larkInviteHeader(larkInviteTitleInvalid, larkCardTemplateGrey)
		card.Body.Elements = larkInviteOpenElements(v, true)
	case larkInviteCardJoined:
		card.Header = larkInviteHeader(fmt.Sprintf(larkInviteTitleJoinedFormat, v.WorkspaceName), larkCardTemplateGreen)
		card.Body.Elements = larkInviteJoinedElements(v)
	default:
		return "", errors.Errorf("unknown lark invite card state %q", string(v.State))
	}

	raw, err := json.Marshal(card)
	if err != nil {
		return "", errors.Wrapf(err, "marshal lark invite card invite_id=%s", v.InviteID)
	}

	return string(raw), nil
}

// buildLarkInviteToast 生成只提示不更新卡片的回调响应，kind 取 larkInviteToast* 常量。
func buildLarkInviteToast(kind, content string) []byte {
	// 结构体只含字符串字段，序列化不会失败。
	raw, _ := json.Marshal(larkInviteCallbackResponse{Toast: larkInviteToast{Type: kind, Content: content}})

	return raw
}

// buildLarkInviteCardResponse 生成提示并更新卡片的回调响应，kind 取 larkInviteToast* 常量，
// card 是 buildLarkInviteCard 的输出。card 不是合法 JSON 时返回错误。
func buildLarkInviteCardResponse(kind, content string, card string) ([]byte, error) {
	raw, err := json.Marshal(larkInviteCallbackResponse{
		Toast: larkInviteToast{Type: kind, Content: content},
		Card:  &larkInviteCardResponse{Type: larkCardResponseTypeRaw, Data: json.RawMessage(card)},
	})
	if err != nil {
		return nil, errors.WithStack(err)
	}

	return raw, nil
}

// larkInviteHeader 构造卡片标题栏，标题为 plain_text。
func larkInviteHeader(title, template string) larkCardHeader {
	return larkCardHeader{
		Title:    larkCardText{Tag: larkCardTagPlainText, Content: title},
		Template: template,
	}
}

// larkInviteOpenElements 构造邀请中和已失效状态的正文，两者结构一致，失效时主按钮禁用并显示失效说明。
func larkInviteOpenElements(v larkInviteCardView, invalid bool) []any {
	elements := []any{larkCardDiv{
		Tag:  larkCardTagDiv,
		Text: larkCardText{Tag: larkCardTagPlainText, Content: larkInviteSentence(v)},
	}}

	if v.Note != "" {
		elements = append(elements, larkCardDiv{
			Tag:  larkCardTagDiv,
			Text: larkCardText{Tag: larkCardTagPlainText, Content: fmt.Sprintf(larkInviteNoteFormat, v.Note)},
		})
	}

	fields := strings.Join([]string{
		fmt.Sprintf(larkInviteFieldFormat, larkInviteFieldRole, escapeLarkInviteMarkdown(larkInviteRoleLabel(v.Role))),
		fmt.Sprintf(larkInviteFieldFormat, larkInviteFieldExpires, formatLarkInviteDate(v.ExpiresAt)),
	}, "\n")
	elements = append(elements, larkCardMarkdown{Tag: larkCardTagMarkdown, Content: fields})

	elements = append(elements, larkCardButton{
		Tag:      larkCardTagButton,
		Text:     larkCardText{Tag: larkCardTagPlainText, Content: larkInviteButtonJoin},
		Type:     larkCardButtonPrimary,
		Disabled: invalid,
		Behaviors: []larkCardBehavior{{
			Type:  larkCardBehaviorCallback,
			Value: &larkInviteCallbackData{Action: larkInviteActionJoin, InviteID: v.InviteID},
		}},
	})
	elements = appendLarkInviteDownload(elements, v.DownloadURL)

	var footer []string
	if invalid && v.InvalidReason != "" {
		footer = append(footer, v.InvalidReason)
	}

	return appendLarkInviteFooter(elements, footer, v.JoinedCount)
}

// larkInviteJoinedElements 构造已加入状态的正文，没有加入按钮。
func larkInviteJoinedElements(v larkInviteCardView) []any {
	elements := []any{larkCardMarkdown{Tag: larkCardTagMarkdown, Content: larkInviteJoinedBody}}
	elements = appendLarkInviteDownload(elements, v.DownloadURL)

	return appendLarkInviteFooter(elements, nil, v.JoinedCount)
}

// appendLarkInviteDownload 在下载地址非空时追加“下载 Marvis”链接按钮。
func appendLarkInviteDownload(elements []any, downloadURL string) []any {
	if downloadURL == "" {
		return elements
	}

	return append(elements, larkCardButton{
		Tag:       larkCardTagButton,
		Text:      larkCardText{Tag: larkCardTagPlainText, Content: larkInviteButtonDownload},
		Type:      larkCardButtonDefault,
		Behaviors: []larkCardBehavior{{Type: larkCardBehaviorOpenURL, DefaultURL: downloadURL}},
	})
}

// appendLarkInviteFooter 追加底部说明：先是 notes，再是“{n} 人已加入”，n 为 0 时不显示；没有任何内容时不加分割线。
func appendLarkInviteFooter(elements []any, notes []string, joinedCount int) []any {
	lines := append([]string(nil), notes...)
	if joinedCount > 0 {
		lines = append(lines, fmt.Sprintf(larkInviteJoinedCountFormat, joinedCount))
	}
	if len(lines) == 0 {
		return elements
	}

	elements = append(elements, larkCardHRElement{Tag: larkCardTagHR})
	for _, line := range lines {
		elements = append(elements, larkCardDiv{
			Tag: larkCardTagDiv,
			Text: larkCardText{
				Tag:       larkCardTagPlainText,
				Content:   line,
				TextSize:  larkCardTextSizeNotation,
				TextColor: larkCardTextColorGrey,
			},
		})
	}

	return elements
}

// larkInviteSentence 生成正文句子（plain_text，名字原样插入），智能体代发时带上智能体名。
// 发送人已删除、名字为空时：有智能体就以智能体为发送人，都没有就只剩“邀请你加入工作区 {工作区}”。
func larkInviteSentence(v larkInviteCardView) string {
	if v.AgentName != "" && v.InviterName != "" {
		return fmt.Sprintf(larkInviteAgentSentenceFormat, v.AgentName, v.InviterName, v.WorkspaceName)
	}

	sender := v.InviterName
	if sender == "" {
		sender = v.AgentName
	}

	return strings.TrimSpace(fmt.Sprintf(larkInviteSentenceFormat, sender, v.WorkspaceName))
}

// larkInviteRoleLabel 把角色取值转成展示文案，未知角色原样返回。
func larkInviteRoleLabel(role string) string {
	switch role {
	case larkInviteRoleMember:
		return larkInviteRoleMemberLabel
	case larkInviteRoleAdmin:
		return larkInviteRoleAdminLabel
	default:
		return role
	}
}

// formatLarkInviteDate 按北京时间格式化卡片日期（有效期、过期说明），例如“1 月 2 日 15:04”。
func formatLarkInviteDate(t time.Time) string {
	return t.In(larkInviteCardLocation).Format(larkInviteDateLayout)
}

// larkInviteLocation 用 load 加载卡片时区；加载失败（容器里没有时区数据）时退回固定的东八区。
func larkInviteLocation(load func(name string) (*time.Location, error)) *time.Location {
	loc, err := load(larkInviteTimeZone)
	if err != nil {
		return time.FixedZone(larkInviteFallbackZoneName, larkInviteFallbackZoneOffset)
	}

	return loc
}

// larkInviteMarkdownEscaper 把飞书 markdown 的 HTML 特殊字符换成实体，飞书卡片文档记载的转义写法即实体。
var larkInviteMarkdownEscaper = strings.NewReplacer(
	`&`, `&amp;`,
	`<`, `&lt;`,
	`>`, `&gt;`,
)

// escapeLarkInviteMarkdown 转义要插入 markdown 元素的值，避免被当成标签或 @ 提及。
// 用户文本不进 markdown，这里只处理固定文案里插入的角色名。
func escapeLarkInviteMarkdown(s string) string {
	return larkInviteMarkdownEscaper.Replace(s)
}
