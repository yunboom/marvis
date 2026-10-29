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
//
// 卡片不用 header：标题行是 column_set（logo 方块 + 标题和副标题 + 状态），颜色全部引用 config.style.color
// 里的自定义 token，按钮是 interactive_container 做的胶囊。

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

	larkCardTagPlainText            = "plain_text"
	larkCardTagMarkdown             = "markdown"
	larkCardTagDiv                  = "div"
	larkCardTagColumnSet            = "column_set"
	larkCardTagColumn               = "column"
	larkCardTagInteractiveContainer = "interactive_container"
	larkCardTagPersonList           = "person_list"

	larkCardBehaviorCallback = "callback"
	larkCardBehaviorOpenURL  = "open_url"

	larkCardWidthModeCompact = "compact"
	larkCardDirectionColumn  = "vertical"
	larkCardFlexModeNone     = "none"
	larkCardWidthAuto        = "auto"
	larkCardWidthWeighted    = "weighted"
	larkCardWidthFill        = "fill"
	larkCardAlignCenter      = "center"

	larkCardTextSizeHeading  = "heading-4"
	larkCardTextSizeNotation = "notation"

	larkCardPersonSizeExtraSmall = "extra_small"

	// larkCardResponseTypeRaw 表示回调响应里的卡片是原始卡片 JSON。
	larkCardResponseTypeRaw = "raw"
)

// 卡片的尺寸和间距。
const (
	larkInviteCardBodyPadding    = "18px 18px 18px 18px"
	larkInviteCardBodySpacing    = "12px"
	larkInviteCardTitleSpacing   = "12px"
	larkInviteCardJoinedSpacing  = "8px"
	larkInviteCardNoSpacing      = "0px"
	larkInviteCardLogoSize       = "36px"
	larkInviteCardLogoRadius     = "10px"
	larkInviteCardNotePadding    = "12px 14px 12px 14px"
	larkInviteCardNoteMaxLines   = 4
	larkInviteCardSubtitleLines  = 1
	larkInviteCardPillHeight     = "40px"
	larkInviteCardPillRadius     = "20px"
	larkInviteCardNoPadding      = "0px"
	larkInviteCardColumnWeight   = 1
	larkInviteCardMaxJoinedFaces = 5
)

// 卡片引用的自定义颜色 token，取值见 larkInviteCardColors；green 是飞书内置颜色。
const (
	larkCardColorInk   = "ink"
	larkCardColorOnInk = "on-ink"
	larkCardColorFaint = "faint"
	larkCardColorBlock = "block"
	larkCardColorLine  = "line"
	larkCardColorGreen = "green"
)

// larkInviteCardColors 是 config.style.color 里的自定义颜色，浅色和深色模式各一套。
var larkInviteCardColors = map[string]larkCardColor{
	larkCardColorInk:   {LightMode: "rgba(15,15,15,1)", DarkMode: "rgba(240,240,240,1)"},
	larkCardColorOnInk: {LightMode: "rgba(255,255,255,1)", DarkMode: "rgba(15,15,15,1)"},
	larkCardColorFaint: {LightMode: "rgba(136,136,136,1)", DarkMode: "rgba(150,150,150,1)"},
	larkCardColorBlock: {LightMode: "rgba(247,247,247,1)", DarkMode: "rgba(255,255,255,0.06)"},
	larkCardColorLine:  {LightMode: "rgba(227,227,227,1)", DarkMode: "rgba(255,255,255,0.16)"},
}

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

// larkInviteBotName 是发送卡片的飞书应用（机器人）名字。
const larkInviteBotName = "Marvis Workbench"

// 卡片产品文案。
const (
	// larkInviteTitleActiveFormat 的参数是工作区名。
	larkInviteTitleActiveFormat = "加入 %s"
	larkInviteTitleInvalid      = "邀请已失效"
	// larkInviteTitleJoinedFormat 的参数是工作区名。
	larkInviteTitleJoinedFormat = "已加入 %s"

	// larkInviteSubtitleFormat 的参数依次是发送人、机器人名。
	larkInviteSubtitleFormat = "%s 邀请 · %s"
	// larkInviteAgentSubtitleFormat 的参数依次是智能体名、发送人、机器人名。
	larkInviteAgentSubtitleFormat = "%s 代 %s 邀请 · %s"

	// larkInviteSummaryFormat 的参数依次是发送人、工作区名。summary 是会话列表里的预览文字。
	larkInviteSummaryFormat = "%s 邀请你加入 %s"
	// larkInviteAgentSummaryFormat 的参数依次是智能体名、发送人、工作区名。
	larkInviteAgentSummaryFormat = "%s 代 %s 邀请你加入 %s"
	// larkInviteAnonymousSummaryFormat 的参数是工作区名，发送人和智能体都已删除时使用。
	larkInviteAnonymousSummaryFormat = "邀请你加入 %s"

	larkInviteStatusLabelJoined  = "已加入"
	larkInviteStatusLabelExpired = "已过期"
	larkInviteStatusLabelRevoked = "已撤销"

	larkInviteJoinedBody = "打开 Marvis，用飞书登录即可使用。"

	larkInviteMetaRole = "角色"
	// larkInviteMetaExpiresFormat 的参数是有效期。
	larkInviteMetaExpiresFormat = "%s 前有效"
	larkInviteMetaUnlimited     = "人数不限"
	// larkInviteMetaMaxUsesFormat 的参数是人数上限。
	larkInviteMetaMaxUsesFormat = "最多 %d 人"
	larkInviteMetaSeparator     = "　·　"
	// larkInviteMetaActiveFormat 的参数依次是“角色”、角色名、其余字段；角色名加粗，其余为灰色。
	larkInviteMetaActiveFormat = "<font color='grey'>%s</font> **%s**　<font color='grey'>·　%s</font>"
	// larkInviteMetaInvalidFormat 的参数同上，失效时整行灰色、不加粗。
	larkInviteMetaInvalidFormat = "<font color='grey'>%s %s　·　%s</font>"

	larkInviteRoleMemberLabel = "成员"
	larkInviteRoleAdminLabel  = "管理员"

	larkInviteLogoLetter  = "M"
	larkInviteButtonJoin  = "加入工作区"
	larkInviteButtonLearn = "了解 Marvis"
	larkInviteButtonOpen  = "打开 Marvis"

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
	// IsGroup 为 true 表示群卡片：显示人数上限和已加入人数。
	IsGroup bool
	// MaxUses 是群卡片人数上限，0 表示不限。
	MaxUses int
	// JoinedCount 为 0 时不显示“已加入”行。
	JoinedCount int
	// JoinedOpenIDs 是已加入的人的飞书 open_id，最近加入的在前；为空时“已加入”行只有人数。
	JoinedOpenIDs []string
	// InvalidStatus 是失效的原因，取 larkInviteStatusExpired 或 larkInviteStatusRevoked。
	InvalidStatus string
	// InvalidReason 是失效状态的底部说明，例如“10 月 20 日已过期”“已撤销”。
	InvalidReason string
	// Links 是卡片上各个链接的地址。
	Links larkInviteCardLinks
}

// larkInviteCardLinks 是卡片上的链接，地址为空时省略对应入口。
type larkInviteCardLinks struct {
	// Landing 是 Marvis 营销页（含路径前缀）。非空时 logo 可点击、显示“了解 Marvis”次按钮。
	Landing string
	// Login 是已加入卡片“打开 Marvis”的链接（网页登录页，登录后进入工作区），为空时不显示这个按钮。
	Login string
}

// larkCard 是卡片 JSON 2.0 的根对象。
type larkCard struct {
	Schema string         `json:"schema"`
	Config larkCardConfig `json:"config"`
	Body   larkCardBody   `json:"body"`
}

// larkCardConfig 是卡片全局配置。
type larkCardConfig struct {
	// UpdateMulti 为 true 时，卡片更新对所有接收人可见。
	UpdateMulti bool            `json:"update_multi"`
	WidthMode   string          `json:"width_mode"`
	Summary     larkCardSummary `json:"summary"`
	Style       larkCardStyle   `json:"style"`
}

// larkCardSummary 是会话列表里的预览文字。
type larkCardSummary struct {
	Content string `json:"content"`
}

// larkCardStyle 是卡片的自定义样式。
type larkCardStyle struct {
	Color map[string]larkCardColor `json:"color"`
}

// larkCardColor 是自定义颜色在浅色和深色模式下的取值（RGBA）。
type larkCardColor struct {
	LightMode string `json:"light_mode"`
	DarkMode  string `json:"dark_mode"`
}

// larkCardBody 是卡片正文。
type larkCardBody struct {
	Direction       string `json:"direction"`
	Padding         string `json:"padding"`
	VerticalSpacing string `json:"vertical_spacing"`
	Elements        []any  `json:"elements"`
}

// larkCardText 是 plain_text 文本对象。
type larkCardText struct {
	Tag       string `json:"tag"`
	Content   string `json:"content"`
	TextSize  string `json:"text_size,omitempty"`
	TextColor string `json:"text_color,omitempty"`
	TextAlign string `json:"text_align,omitempty"`
	Lines     int    `json:"lines,omitempty"`
}

// larkCardMarkdown 是 markdown 元素。
type larkCardMarkdown struct {
	Tag      string `json:"tag"`
	Content  string `json:"content"`
	TextSize string `json:"text_size,omitempty"`
}

// larkCardDiv 是承载 plain_text 的 div 元素。
type larkCardDiv struct {
	Tag  string       `json:"tag"`
	Text larkCardText `json:"text"`
}

// larkCardColumnSet 是分栏元素。
type larkCardColumnSet struct {
	Tag               string           `json:"tag"`
	FlexMode          string           `json:"flex_mode"`
	HorizontalSpacing string           `json:"horizontal_spacing,omitempty"`
	BackgroundStyle   string           `json:"background_style,omitempty"`
	Columns           []larkCardColumn `json:"columns"`
}

// larkCardColumn 是分栏里的一列。
type larkCardColumn struct {
	Tag             string `json:"tag"`
	Width           string `json:"width"`
	Weight          int    `json:"weight,omitempty"`
	VerticalAlign   string `json:"vertical_align,omitempty"`
	VerticalSpacing string `json:"vertical_spacing,omitempty"`
	Padding         string `json:"padding,omitempty"`
	BackgroundStyle string `json:"background_style,omitempty"`
	Elements        []any  `json:"elements"`
}

// larkCardInteractiveContainer 是可点击的容器，卡片用它做 logo 和胶囊按钮。
type larkCardInteractiveContainer struct {
	Tag             string             `json:"tag"`
	Width           string             `json:"width"`
	Height          string             `json:"height"`
	BackgroundStyle string             `json:"background_style,omitempty"`
	HasBorder       bool               `json:"has_border,omitempty"`
	BorderColor     string             `json:"border_color,omitempty"`
	CornerRadius    string             `json:"corner_radius"`
	Padding         string             `json:"padding"`
	HorizontalAlign string             `json:"horizontal_align"`
	VerticalAlign   string             `json:"vertical_align"`
	Disabled        bool               `json:"disabled,omitempty"`
	Behaviors       []larkCardBehavior `json:"behaviors"`
	Elements        []any              `json:"elements"`
}

// larkCardPersonList 是人员列表元素，卡片用它显示已加入的人的头像。
type larkCardPersonList struct {
	Tag               string           `json:"tag"`
	Persons           []larkCardPerson `json:"persons"`
	ShowName          bool             `json:"show_name"`
	ShowAvatar        bool             `json:"show_avatar"`
	Size              string           `json:"size"`
	DropInvalidUserID bool             `json:"drop_invalid_user_id"`
}

// larkCardPerson 是人员列表里的一个人，ID 是 open_id。
type larkCardPerson struct {
	ID string `json:"id"`
}

// larkCardBehavior 是点击行为：回调或打开链接。
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
	var elements []any
	switch v.State {
	case larkInviteCardActive:
		elements = larkInviteActiveElements(v)
	case larkInviteCardInvalid:
		elements = larkInviteInvalidElements(v)
	case larkInviteCardJoined:
		elements = larkInviteJoinedElements(v)
	default:
		return "", errors.Errorf("unknown lark invite card state %q", string(v.State))
	}

	card := larkCard{
		Schema: larkCardSchemaVersion,
		Config: larkCardConfig{
			UpdateMulti: true,
			WidthMode:   larkCardWidthModeCompact,
			Summary:     larkCardSummary{Content: larkInviteSummary(v)},
			Style:       larkCardStyle{Color: larkInviteCardColors},
		},
		Body: larkCardBody{
			Direction:       larkCardDirectionColumn,
			Padding:         larkInviteCardBodyPadding,
			VerticalSpacing: larkInviteCardBodySpacing,
			Elements:        elements,
		},
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

// larkInviteActiveElements 构造邀请中状态的正文：标题行、附言、角色和有效期、加入和次按钮、群卡片的已加入行。
func larkInviteActiveElements(v larkInviteCardView) []any {
	elements := []any{larkInviteTitleRow(larkInviteTitleRowOptions{
		Title:      fmt.Sprintf(larkInviteTitleActiveFormat, v.WorkspaceName),
		Subtitle:   larkInviteSubtitle(v),
		LogoBG:     larkCardColorInk,
		LandingURL: v.Links.Landing,
	})}
	elements = appendLarkInviteNote(elements, v.Note, false)
	elements = append(elements,
		larkInviteMeta(v, false),
		larkInviteJoinButton(v.InviteID, false),
	)
	elements = appendLarkInviteSecondary(elements, v.Links)

	if v.IsGroup && v.JoinedCount > 0 {
		elements = append(elements, larkInviteJoinedRow(v))
	}

	return elements
}

// larkInviteInvalidElements 构造已失效状态的正文：结构同邀请中，logo、标题、附言和字段变灰，加入按钮禁用，
// 底部是失效说明；不显示已加入行。
func larkInviteInvalidElements(v larkInviteCardView) []any {
	elements := []any{larkInviteTitleRow(larkInviteTitleRowOptions{
		Title:       larkInviteTitleInvalid,
		TitleColor:  larkCardColorFaint,
		Subtitle:    larkInviteSubtitle(v),
		LogoBG:      larkCardColorFaint,
		LandingURL:  v.Links.Landing,
		Status:      larkInviteInvalidStatusLabel(v.InvalidStatus),
		StatusColor: larkCardColorFaint,
	})}
	elements = appendLarkInviteNote(elements, v.Note, true)
	elements = append(elements,
		larkInviteMeta(v, true),
		larkInviteJoinButton(v.InviteID, true),
	)
	elements = appendLarkInviteSecondary(elements, v.Links)

	if v.InvalidReason != "" {
		elements = append(elements, larkInviteNotation(v.InvalidReason))
	}

	return elements
}

// larkInviteJoinedElements 构造已加入状态的正文（个人卡片点击加入后）：没有附言和字段，
// 主按钮是“打开 Marvis”，没有登录地址时只留次按钮。
func larkInviteJoinedElements(v larkInviteCardView) []any {
	elements := []any{
		larkInviteTitleRow(larkInviteTitleRowOptions{
			Title:       fmt.Sprintf(larkInviteTitleJoinedFormat, v.WorkspaceName),
			Subtitle:    larkInviteBotName,
			LogoBG:      larkCardColorInk,
			LandingURL:  v.Links.Landing,
			Status:      larkInviteStatusLabelJoined,
			StatusColor: larkCardColorGreen,
		}),
		larkCardDiv{Tag: larkCardTagDiv, Text: larkCardText{Tag: larkCardTagPlainText, Content: larkInviteJoinedBody}},
	}

	if v.Links.Login != "" {
		elements = append(elements, larkInvitePrimaryPill(larkInviteButtonOpen, larkCardBehavior{Type: larkCardBehaviorOpenURL, DefaultURL: v.Links.Login}, false))
	}

	return appendLarkInviteSecondary(elements, v.Links)
}

// larkInviteTitleRowOptions 是标题行的内容和颜色，颜色为空时用默认文字色；Status 为空时不显示状态。
type larkInviteTitleRowOptions struct {
	Title       string
	TitleColor  string
	Subtitle    string
	LogoBG      string
	LandingURL  string
	Status      string
	StatusColor string
}

// larkInviteTitleRow 构造标题行：左侧 logo 方块，中间标题和副标题，右侧可选的状态文字。
func larkInviteTitleRow(o larkInviteTitleRowOptions) larkCardColumnSet {
	columns := []larkCardColumn{
		larkInviteLogoColumn(o.LogoBG, o.LandingURL),
		{
			Tag:             larkCardTagColumn,
			Width:           larkCardWidthWeighted,
			Weight:          larkInviteCardColumnWeight,
			VerticalAlign:   larkCardAlignCenter,
			VerticalSpacing: larkInviteCardNoSpacing,
			Elements: []any{
				larkCardDiv{Tag: larkCardTagDiv, Text: larkCardText{
					Tag:       larkCardTagPlainText,
					Content:   o.Title,
					TextSize:  larkCardTextSizeHeading,
					TextColor: o.TitleColor,
				}},
				larkCardDiv{Tag: larkCardTagDiv, Text: larkCardText{
					Tag:       larkCardTagPlainText,
					Content:   o.Subtitle,
					TextSize:  larkCardTextSizeNotation,
					TextColor: larkCardColorFaint,
					Lines:     larkInviteCardSubtitleLines,
				}},
			},
		},
	}

	if o.Status != "" {
		columns = append(columns, larkCardColumn{
			Tag:           larkCardTagColumn,
			Width:         larkCardWidthAuto,
			VerticalAlign: larkCardAlignCenter,
			Elements: []any{larkCardDiv{Tag: larkCardTagDiv, Text: larkCardText{
				Tag:       larkCardTagPlainText,
				Content:   o.Status,
				TextSize:  larkCardTextSizeNotation,
				TextColor: o.StatusColor,
			}}},
		})
	}

	return larkCardColumnSet{
		Tag:               larkCardTagColumnSet,
		FlexMode:          larkCardFlexModeNone,
		HorizontalSpacing: larkInviteCardTitleSpacing,
		Columns:           columns,
	}
}

// larkInviteLogoColumn 构造标题行左侧的 logo 列。有首页地址时 logo 是圆角的可点击容器，点开首页；
// 没有时退回带底色的普通列，列不支持圆角，是直角方块。
func larkInviteLogoColumn(background, landingURL string) larkCardColumn {
	letter := larkCardDiv{Tag: larkCardTagDiv, Text: larkCardText{
		Tag:       larkCardTagPlainText,
		Content:   larkInviteLogoLetter,
		TextSize:  larkCardTextSizeHeading,
		TextColor: larkCardColorOnInk,
		TextAlign: larkCardAlignCenter,
	}}

	if landingURL == "" {
		return larkCardColumn{
			Tag:             larkCardTagColumn,
			Width:           larkInviteCardLogoSize,
			VerticalAlign:   larkCardAlignCenter,
			BackgroundStyle: background,
			Elements:        []any{letter},
		}
	}

	return larkCardColumn{
		Tag:           larkCardTagColumn,
		Width:         larkCardWidthAuto,
		VerticalAlign: larkCardAlignCenter,
		Elements: []any{larkCardInteractiveContainer{
			Tag:             larkCardTagInteractiveContainer,
			Width:           larkInviteCardLogoSize,
			Height:          larkInviteCardLogoSize,
			BackgroundStyle: background,
			CornerRadius:    larkInviteCardLogoRadius,
			Padding:         larkInviteCardNoPadding,
			HorizontalAlign: larkCardAlignCenter,
			VerticalAlign:   larkCardAlignCenter,
			Behaviors:       []larkCardBehavior{{Type: larkCardBehaviorOpenURL, DefaultURL: landingURL}},
			Elements:        []any{letter},
		}},
	}
}

// appendLarkInviteNote 在附言非空时追加灰底附言块，失效时文字变灰。
func appendLarkInviteNote(elements []any, note string, faint bool) []any {
	if note == "" {
		return elements
	}

	text := larkCardText{Tag: larkCardTagPlainText, Content: note, Lines: larkInviteCardNoteMaxLines}
	if faint {
		text.TextColor = larkCardColorFaint
	}

	return append(elements, larkCardColumnSet{
		Tag:             larkCardTagColumnSet,
		FlexMode:        larkCardFlexModeNone,
		BackgroundStyle: larkCardColorBlock,
		Columns: []larkCardColumn{{
			Tag:      larkCardTagColumn,
			Width:    larkCardWidthWeighted,
			Weight:   larkInviteCardColumnWeight,
			Padding:  larkInviteCardNotePadding,
			Elements: []any{larkCardDiv{Tag: larkCardTagDiv, Text: text}},
		}},
	})
}

// larkInviteMeta 构造“角色 · 有效期 · 人数”一行（markdown，只含固定文案、日期和转义后的角色名）。
// 群卡片带人数上限；失效时整行变灰。
func larkInviteMeta(v larkInviteCardView, invalid bool) larkCardMarkdown {
	parts := []string{fmt.Sprintf(larkInviteMetaExpiresFormat, formatLarkInviteDate(v.ExpiresAt))}
	if v.IsGroup {
		parts = append(parts, larkInviteMaxUsesLabel(v.MaxUses))
	}
	rest := strings.Join(parts, larkInviteMetaSeparator)
	role := escapeLarkInviteMarkdown(larkInviteRoleLabel(v.Role))

	format := larkInviteMetaActiveFormat
	if invalid {
		format = larkInviteMetaInvalidFormat
	}

	return larkCardMarkdown{
		Tag:      larkCardTagMarkdown,
		Content:  fmt.Sprintf(format, larkInviteMetaRole, role, rest),
		TextSize: larkCardTextSizeNotation,
	}
}

// larkInviteMaxUsesLabel 返回群卡片的人数说明，0 表示不限。
func larkInviteMaxUsesLabel(maxUses int) string {
	if maxUses <= 0 {
		return larkInviteMetaUnlimited
	}

	return fmt.Sprintf(larkInviteMetaMaxUsesFormat, maxUses)
}

// larkInviteJoinButton 构造“加入工作区”主按钮，回传 action 和 invite_id；失效时禁用。
func larkInviteJoinButton(inviteID string, disabled bool) larkCardInteractiveContainer {
	return larkInvitePrimaryPill(larkInviteButtonJoin, larkCardBehavior{
		Type:  larkCardBehaviorCallback,
		Value: &larkInviteCallbackData{Action: larkInviteActionJoin, InviteID: inviteID},
	}, disabled)
}

// larkInvitePrimaryPill 构造黑底白字的胶囊主按钮；禁用时换成浅灰底、灰字。
func larkInvitePrimaryPill(label string, behavior larkCardBehavior, disabled bool) larkCardInteractiveContainer {
	background, textColor := larkCardColorInk, larkCardColorOnInk
	if disabled {
		background, textColor = larkCardColorLine, larkCardColorFaint
	}

	pill := larkInvitePill(label, textColor, behavior)
	pill.BackgroundStyle = background
	pill.Disabled = disabled

	return pill
}

// appendLarkInviteSecondary 追加描边的“了解 Marvis”次按钮，营销页地址为空时不加。
func appendLarkInviteSecondary(elements []any, links larkInviteCardLinks) []any {
	if links.Landing == "" {
		return elements
	}

	pill := larkInvitePill(larkInviteButtonLearn, "", larkCardBehavior{Type: larkCardBehaviorOpenURL, DefaultURL: links.Landing})
	pill.HasBorder = true
	pill.BorderColor = larkCardColorLine

	return append(elements, pill)
}

// larkInvitePill 构造通栏胶囊按钮的公共部分：高度、圆角、居中的 plain_text 文字和点击行为。
func larkInvitePill(label, textColor string, behavior larkCardBehavior) larkCardInteractiveContainer {
	return larkCardInteractiveContainer{
		Tag:             larkCardTagInteractiveContainer,
		Width:           larkCardWidthFill,
		Height:          larkInviteCardPillHeight,
		CornerRadius:    larkInviteCardPillRadius,
		Padding:         larkInviteCardNoPadding,
		HorizontalAlign: larkCardAlignCenter,
		VerticalAlign:   larkCardAlignCenter,
		Behaviors:       []larkCardBehavior{behavior},
		Elements: []any{larkCardDiv{Tag: larkCardTagDiv, Text: larkCardText{
			Tag:       larkCardTagPlainText,
			Content:   label,
			TextColor: textColor,
			TextAlign: larkCardAlignCenter,
		}}},
	}
}

// larkInviteJoinedRow 构造群卡片的已加入行：有 open_id 时先放最多 larkInviteCardMaxJoinedFaces 个头像，
// 再是“{n} 人已加入”。
func larkInviteJoinedRow(v larkInviteCardView) larkCardColumnSet {
	var columns []larkCardColumn

	if len(v.JoinedOpenIDs) > 0 {
		ids := v.JoinedOpenIDs[:min(len(v.JoinedOpenIDs), larkInviteCardMaxJoinedFaces)]
		persons := make([]larkCardPerson, 0, len(ids))
		for _, id := range ids {
			persons = append(persons, larkCardPerson{ID: id})
		}

		columns = append(columns, larkCardColumn{
			Tag:           larkCardTagColumn,
			Width:         larkCardWidthAuto,
			VerticalAlign: larkCardAlignCenter,
			Elements: []any{larkCardPersonList{
				Tag:               larkCardTagPersonList,
				Persons:           persons,
				ShowName:          false,
				ShowAvatar:        true,
				Size:              larkCardPersonSizeExtraSmall,
				DropInvalidUserID: true,
			}},
		})
	}

	columns = append(columns, larkCardColumn{
		Tag:           larkCardTagColumn,
		Width:         larkCardWidthWeighted,
		Weight:        larkInviteCardColumnWeight,
		VerticalAlign: larkCardAlignCenter,
		Elements:      []any{larkInviteNotation(fmt.Sprintf(larkInviteJoinedCountFormat, v.JoinedCount))},
	})

	return larkCardColumnSet{
		Tag:               larkCardTagColumnSet,
		FlexMode:          larkCardFlexModeNone,
		HorizontalSpacing: larkInviteCardJoinedSpacing,
		Columns:           columns,
	}
}

// larkInviteNotation 构造灰色小字的 plain_text 行。
func larkInviteNotation(content string) larkCardDiv {
	return larkCardDiv{Tag: larkCardTagDiv, Text: larkCardText{
		Tag:       larkCardTagPlainText,
		Content:   content,
		TextSize:  larkCardTextSizeNotation,
		TextColor: larkCardColorFaint,
	}}
}

// larkInviteSubtitle 生成标题下的副标题“{发送人} 邀请 · Marvis Workbench”，智能体代发时带上智能体名。
// 发送人已删除、名字为空时：有智能体就以智能体为发送人，都没有就只剩机器人名。
func larkInviteSubtitle(v larkInviteCardView) string {
	if v.AgentName != "" && v.InviterName != "" {
		return fmt.Sprintf(larkInviteAgentSubtitleFormat, v.AgentName, v.InviterName, larkInviteBotName)
	}

	sender := larkInviteCardSender(v)
	if sender == "" {
		return larkInviteBotName
	}

	return fmt.Sprintf(larkInviteSubtitleFormat, sender, larkInviteBotName)
}

// larkInviteSummary 生成会话列表里的预览文字，发送人的取法同 larkInviteSubtitle。
func larkInviteSummary(v larkInviteCardView) string {
	if v.AgentName != "" && v.InviterName != "" {
		return fmt.Sprintf(larkInviteAgentSummaryFormat, v.AgentName, v.InviterName, v.WorkspaceName)
	}

	sender := larkInviteCardSender(v)
	if sender == "" {
		return fmt.Sprintf(larkInviteAnonymousSummaryFormat, v.WorkspaceName)
	}

	return fmt.Sprintf(larkInviteSummaryFormat, sender, v.WorkspaceName)
}

// larkInviteCardSender 返回单独署名时的发送人：优先发送人，发送人已删除时用智能体名。
func larkInviteCardSender(v larkInviteCardView) string {
	if v.InviterName != "" {
		return v.InviterName
	}

	return v.AgentName
}

// larkInviteInvalidStatusLabel 把失效原因转成标题行右侧的状态文字。
func larkInviteInvalidStatusLabel(status string) string {
	switch status {
	case larkInviteStatusRevoked:
		return larkInviteStatusLabelRevoked
	case larkInviteStatusExpired:
		return larkInviteStatusLabelExpired
	default:
		return ""
	}
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
