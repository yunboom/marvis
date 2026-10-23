package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/pkg/errors"
	"github.com/spf13/cobra"

	"github.com/yunboom/marvis/server/internal/cli"
	"github.com/yunboom/marvis/server/internal/landiscovery"
)

const (
	// defaultServerAddress 是手动输入服务器地址时的默认值：mDNS 主机名加后端默认端口。
	defaultServerAddress = "http://marvis.local:13840"

	// discoverTimeout 是局域网查找的等待时间。
	discoverTimeout = 3 * time.Second
	// identityTimeout 是单次读取 /api/config 的超时时间，.local 地址用 mdnsProbeTimeout。
	identityTimeout = 3 * time.Second
	// maxPort 是 TCP 端口号上限。
	maxPort = 65535
	// maxConfigBodyBytes 限制 /api/config 响应体的读取量。
	maxConfigBodyBytes = 1 << 20

	// serverConfigPath 是服务器公开配置接口，用于核实服务器身份。
	serverConfigPath = "/api/config"

	urlSchemeHTTP  = "http"
	urlSchemeHTTPS = "https"
	urlSchemeSep   = "://"

	// defaultChoice 是菜单里直接回车选中的序号。
	defaultChoice = 1
	// columnGap 是菜单各列之间的空格数。
	columnGap = 2

	manualEntryLabel = "Enter an address manually"
	desktopInUseNote = "in use by desktop"
	thisComputerNote = "this computer"
	// noteSeparator 连接同一行里的多条备注。
	noteSeparator = ", "

	// noWebAppGuidance 在服务器没有网页端时提示改用令牌登录。
	noWebAppGuidance = "No web app is configured for this server. Log in with `marvis login --token` using a token from Marvis Desktop → Settings → API Token."
)

// wideRuneRanges 是终端里占两列的字符区间（中日韩文字、全角字符、表情）。
var wideRuneRanges = [][2]rune{
	{0x1100, 0x115F},
	{0x2E80, 0xA4CF},
	{0xAC00, 0xD7A3},
	{0xF900, 0xFAFF},
	{0xFE30, 0xFE6F},
	{0xFF00, 0xFF60},
	{0xFFE0, 0xFFE6},
	{0x1F300, 0x1F64F},
	{0x1F900, 0x1F9FF},
	{0x20000, 0x3FFFD},
}

// candidate 是菜单里的一个候选服务器。
type candidate struct {
	URL string
	// Host 是广播的主机名（如 marvis.local），只用于显示；为空时显示地址里的主机。
	Host          string
	Name          string
	ServerVersion string
	InstanceID    string
	// FromDesktop 为 true 表示桌面端正在使用这台服务器。
	FromDesktop bool
	// Local 为 true 表示这是本机 localhost 上的服务器。
	Local bool
}

// serverIdentity 是 /api/config 核实出的服务器身份。
type serverIdentity struct {
	Name       string
	Version    string
	InstanceID string
	// AppURL 是网页端地址，为空表示没有网页端。
	AppURL string
}

// serverConfigResponse 是 /api/config 里与服务器身份相关的字段。
type serverConfigResponse struct {
	ServerName    string `json:"server_name"`
	ServerVersion string `json:"server_version"`
	InstanceID    string `json:"instance_id"`
	DaemonAppURL  string `json:"daemon_app_url"`
}

// identityFetcher 读取并核实一台服务器的身份，测试里替换为桩。
type identityFetcher func(ctx context.Context, baseURL string) (serverIdentity, error)

// discoverDeps 是选择流程依赖的外部能力，测试里替换为桩。
type discoverDeps struct {
	desktop func() (cli.DesktopServer, bool)
	browse  func(ctx context.Context, timeout time.Duration) ([]landiscovery.Entry, error)
	fetch   identityFetcher
	probe   func(baseURL string) bool
	// localAddrs 返回本机网卡上的地址，lookupHost 解析主机名，两者用来判断所选服务器是否在本机。
	localAddrs func() []net.IP
	lookupHost func(ctx context.Context, host string) ([]net.IP, error)
}

// discoveredServer 是选择流程的结果。
type discoveredServer struct {
	URL string
	// AppURL 是所选服务器 /api/config 里的网页端地址，可能是回环地址；为空表示没有网页端。
	AppURL string
	// Local 为 true 表示服务器就在本机，回环的网页端地址可以使用。
	Local bool
}

// localProbe 是本机 localhost 探测的结果。
type localProbe struct {
	identity serverIdentity
	err      error
}

// newDiscoverDeps 返回访问真实环境的依赖。
func newDiscoverDeps() discoverDeps {
	return discoverDeps{
		desktop: func() (cli.DesktopServer, bool) {
			dir, err := os.UserConfigDir()
			if err != nil {
				return cli.DesktopServer{}, false
			}

			return cli.ReadDesktopSelectedServer(dir)
		},
		browse:     landiscovery.Browse,
		fetch:      fetchServerIdentity,
		probe:      probeServer,
		localAddrs: listLocalAddrs,
		lookupHost: lookupHostIPs,
	}
}

// shouldDiscoverSelfHostServer 判断 setup self-host 是否先走选择服务器的流程：
// 必须在终端里运行，且没有通过 --server-url、MARVIS_SERVER_URL 或已有配置指定服务器。
// 显式传了 --port 或 --frontend-port 表示要连本机，同样不进入选择流程。
func shouldDiscoverSelfHostServer(cmd *cobra.Command, userProvidedServerURL, interactive bool) bool {
	if !interactive || userProvidedServerURL {
		return false
	}

	return !cmd.Flags().Changed("port") && !cmd.Flags().Changed("frontend-port")
}

// stdinIsTerminal 判断标准输入是否连着终端。
func stdinIsTerminal() bool {
	return isTerminalFile(os.Stdin)
}

// isTerminalFile 判断文件是否是终端。与 logger.isTerminal 一样看字符设备标志，
// 但 /dev/null 也是字符设备却不是终端，需要排除。
func isTerminalFile(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}

	if info.Mode()&os.ModeCharDevice == 0 {
		return false
	}

	devNull, err := os.Stat(os.DevNull)
	if err == nil && os.SameFile(info, devNull) {
		return false
	}

	return true
}

// writef 向 w 输出格式化文本。终端输出失败时无从处理，写入错误直接忽略。
func writef(w io.Writer, format string, args ...any) {
	_, _ = fmt.Fprintf(w, format, args...)
}

// writeln 向 w 输出一行文本，写入错误的处理同 writef。
func writeln(w io.Writer, args ...any) {
	_, _ = fmt.Fprintln(w, args...)
}

// printNoWebAppGuidance 提示没有网页端时如何登录。
func printNoWebAppGuidance(w io.Writer) {
	writeln(w, noWebAppGuidance)
}

// discoverSelfHostServer 在局域网内查找 Marvis 服务器并让用户选择一台。
// 查找的同时探测本机 localURL：本机有服务器时它排在最前并作为默认项，
// 桌面端正在使用的服务器紧随其后；查找失败不阻止手动输入地址。
func discoverSelfHostServer(ctx context.Context, deps discoverDeps, localURL string, in io.Reader, out io.Writer) (discoveredServer, error) {
	var desktop *cli.DesktopServer
	if selected, ok := deps.desktop(); ok {
		desktop = &selected
		writef(out, "Desktop is using: %s\n", displayServerName(sanitizeLANText(selected.Name), selected.URL))
	}

	writef(out, "Looking for Marvis servers on the local network…")

	// 本机探测与局域网查找互不依赖，同时进行。
	localDone := make(chan localProbe, 1)
	go func() {
		identity, err := deps.fetch(ctx, localURL)
		localDone <- localProbe{identity: identity, err: err}
	}()

	entries, browseErr := deps.browse(ctx, discoverTimeout)
	local := <-localDone

	if browseErr != nil {
		// 查找失败时仍可手动输入地址，把原因告诉用户后继续。
		writef(out, " failed: %v\n", browseErr)

		entries = nil
	}

	known := make(map[string]serverIdentity, 1)

	var localCand *candidate
	if local.err == nil {
		known[localURL] = local.identity
		localCand = &candidate{URL: localURL, Name: local.identity.Name, InstanceID: local.identity.InstanceID, Local: true}
	}

	cands, identities := verifyCandidates(ctx, mergeCandidates(localCand, desktop, entries), known, deps.fetch)

	if browseErr == nil {
		if found := countAnnounced(cands, entries); found > 0 {
			writef(out, " found %d\n", found)
		} else {
			writeln(out, " none found")

			// 本机或桌面端在用的服务器仍可选择时，不必再提示网络环境。
			if len(cands) == 0 {
				writeln(out, "The computer and the server need to be on the same local network.")
			}
		}
	}

	writeln(out)

	picked, err := pickServer(in, out, cands, deps.probe)
	if err != nil {
		return discoveredServer{}, err
	}

	identity, ok := identities[picked]
	if !ok {
		fetched, fetchErr := deps.fetch(ctx, picked)
		if fetchErr != nil {
			writef(out, "Could not read the server configuration: %s\n", stripUnsafeRunes(fetchErr.Error()))
		} else {
			identity, ok = fetched, true
		}
	}

	if ok {
		writef(out, "✓ %s\n", describeServer(identity, picked))
	}

	return discoveredServer{URL: picked, AppURL: identity.AppURL, Local: isLocalServer(ctx, deps, picked)}, nil
}

// describeServer 把核实后的服务器渲染为 “名称 · 版本 (地址)”。
func describeServer(identity serverIdentity, serverURL string) string {
	parts := []string{displayServerName(identity.Name, serverURL)}
	if identity.Version != "" {
		parts = append(parts, formatVersion(identity.Version))
	}

	return fmt.Sprintf("%s (%s)", strings.Join(parts, " · "), serverURL)
}

// displayServerName 在名称为空时退回到地址里的主机和端口。
func displayServerName(name, serverURL string) string {
	if name != "" {
		return name
	}

	return hostPort(serverURL)
}

// hostPort 返回地址里的 host:port 部分。
func hostPort(serverURL string) string {
	parsed, err := url.Parse(serverURL)
	if err != nil || parsed.Host == "" {
		return serverURL
	}

	return parsed.Host
}

// formatVersion 给版本号补上 v 前缀。
func formatVersion(version string) string {
	return "v" + strings.TrimPrefix(version, "v")
}

// entryURL 用广播的地址和端口拼出服务器地址：优先用私有网段 IPv4，其次任意 IPv4，
// 都没有时退回主机名。用 IP 不依赖 .local 解析；服务器换了 IP 后按实例 ID 重新识别。
// 主机名含有地址里不该出现的字符时放弃这条广播。
func entryURL(entry landiscovery.Entry) (string, bool) {
	if entry.Port <= 0 || entry.Port > maxPort {
		return "", false
	}

	port := strconv.Itoa(entry.Port)

	if ip := preferredIPv4(entry.IPs); ip != nil {
		return urlSchemeHTTP + urlSchemeSep + net.JoinHostPort(ip.String(), port), true
	}

	host, ok := urlHostname(entry.Host)
	if !ok {
		return "", false
	}

	return urlSchemeHTTP + urlSchemeSep + net.JoinHostPort(host, port), true
}

// preferredIPv4 返回第一个私有网段 IPv4，没有时返回第一个 IPv4，都没有时返回 nil。
func preferredIPv4(ips []net.IP) net.IP {
	var fallback net.IP

	for _, ip := range ips {
		v4 := ip.To4()
		if v4 == nil {
			continue
		}

		if v4.IsPrivate() {
			return v4
		}

		if fallback == nil {
			fallback = v4
		}
	}

	return fallback
}

// mergeCandidates 合并本机的服务器、桌面端已选的服务器和局域网发现的服务器：
// 本机的排第一，桌面端的其次，同一台服务器（实例 ID 或地址相同）只保留一项，其余按名称排序。
// 广播给出的文本先经 sanitizeLANText 清理。
func mergeCandidates(local *candidate, desktop *cli.DesktopServer, found []landiscovery.Entry) []candidate {
	var merged []candidate

	if local != nil {
		merged = append(merged, *local)
	}

	if desktop != nil && desktop.URL != "" {
		next := candidate{
			URL:         desktop.URL,
			Name:        sanitizeLANText(desktop.Name),
			InstanceID:  sanitizeLANText(desktop.InstanceID),
			FromDesktop: true,
		}

		if idx := indexOfCandidate(merged, next); idx >= 0 {
			merged[idx].FromDesktop = true
			fillCandidate(&merged[idx], next)
		} else {
			merged = append(merged, next)
		}
	}

	pinned := len(merged)

	for _, entry := range found {
		serverURL, ok := entryURL(entry)
		if !ok {
			continue
		}

		host, _ := urlHostname(entry.Host)
		next := candidate{
			URL:           serverURL,
			Host:          host,
			Name:          sanitizeLANText(entry.Name),
			ServerVersion: sanitizeLANText(entry.ServerVersion),
			InstanceID:    sanitizeLANText(entry.InstanceID),
		}

		if idx := indexOfCandidate(merged, next); idx >= 0 {
			fillCandidate(&merged[idx], next)

			continue
		}

		merged = append(merged, next)
	}

	others := merged[pinned:]
	sort.SliceStable(others, func(i, j int) bool {
		left, right := strings.ToLower(others[i].Name), strings.ToLower(others[j].Name)
		if left != right {
			return left < right
		}

		return others[i].URL < others[j].URL
	})

	for i := range merged {
		merged[i].Name = displayServerName(merged[i].Name, merged[i].URL)
	}

	return merged
}

// indexOfCandidate 返回与 target 是同一台服务器的候选下标，没有时返回 -1。
func indexOfCandidate(cands []candidate, target candidate) int {
	for i, c := range cands {
		if c.URL == target.URL || (c.InstanceID != "" && c.InstanceID == target.InstanceID) {
			return i
		}
	}

	return -1
}

// fillCandidate 用 extra 补全 base 里缺失的信息。
func fillCandidate(base *candidate, extra candidate) {
	if base.Name == "" {
		base.Name = extra.Name
	}

	if base.ServerVersion == "" {
		base.ServerVersion = extra.ServerVersion
	}

	if base.InstanceID == "" {
		base.InstanceID = extra.InstanceID
	}

	if base.Host == "" {
		base.Host = extra.Host
	}
}

// countAnnounced 统计候选里有多少台是局域网里广播过的。
func countAnnounced(cands []candidate, found []landiscovery.Entry) int {
	urls := make(map[string]bool, len(found))
	ids := make(map[string]bool, len(found))

	for _, entry := range found {
		if serverURL, ok := entryURL(entry); ok {
			urls[serverURL] = true
		}

		if entry.InstanceID != "" {
			ids[entry.InstanceID] = true
		}
	}

	var count int

	for _, c := range cands {
		if urls[c.URL] || (c.InstanceID != "" && ids[c.InstanceID]) {
			count++
		}
	}

	return count
}

// verifyCandidates 并发读取各候选的 /api/config 来核实身份，返回通过核实的候选
// 和以地址为键的身份。known 里已有身份的地址不再重复读取。
// 核实不通过（连不上、不是 Marvis、版本过旧）的局域网候选会被丢弃；
// 本机和桌面端正在使用的服务器即使暂时连不上或版本较旧也保留，由用户决定是否选它。
func verifyCandidates(ctx context.Context, cands []candidate, known map[string]serverIdentity, fetch identityFetcher) ([]candidate, map[string]serverIdentity) {
	type result struct {
		identity serverIdentity
		ok       bool
	}

	results := make([]result, len(cands))

	// 各候选互不依赖，并发发出；每个协程只写自己下标的元素。
	var wg sync.WaitGroup

	for i, c := range cands {
		if identity, ok := known[c.URL]; ok {
			results[i] = result{identity: identity, ok: true}

			continue
		}

		wg.Go(func() {
			identity, err := fetch(ctx, c.URL)
			results[i] = result{identity: identity, ok: err == nil}
		})
	}

	wg.Wait()

	verified := make([]candidate, 0, len(cands))
	identities := make(map[string]serverIdentity, len(cands))

	for i, c := range cands {
		res := results[i]

		// 响应里没有 instance_id 说明服务器版本过旧，不能作为发现结果使用。
		if !c.FromDesktop && !c.Local && (!res.ok || res.identity.InstanceID == "") {
			continue
		}

		if res.ok {
			identities[c.URL] = res.identity

			if res.identity.Name != "" {
				c.Name = res.identity.Name
			}

			if res.identity.Version != "" {
				c.ServerVersion = res.identity.Version
			}

			if res.identity.InstanceID != "" {
				c.InstanceID = res.identity.InstanceID
			}
		}

		verified = append(verified, c)
	}

	return verified, identities
}

// fetchServerIdentity 读取服务器的 /api/config，得到名称、版本、实例 ID 和网页端地址。
// 老版本服务器的响应里没有 instance_id，此时返回的 InstanceID 为空。
// .local 地址要靠组播解析，超时放宽到 mdnsProbeTimeout。返回的文本已经过 sanitizeLANText 清理。
func fetchServerIdentity(ctx context.Context, baseURL string) (serverIdentity, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeoutFor(baseURL, identityTimeout))
	defer cancel()

	endpoint := strings.TrimRight(baseURL, "/") + serverConfigPath

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return serverIdentity{}, errors.Wrapf(err, "build server config request url=%s", endpoint)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return serverIdentity{}, errors.Wrapf(err, "fetch server config url=%s", endpoint)
	}

	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return serverIdentity{}, errors.Errorf("fetch server config url=%s status=%d", endpoint, resp.StatusCode)
	}

	var config serverConfigResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxConfigBodyBytes)).Decode(&config); err != nil {
		return serverIdentity{}, errors.Wrapf(err, "decode server config url=%s", endpoint)
	}

	return serverIdentity{
		Name:       sanitizeLANText(config.ServerName),
		Version:    sanitizeLANText(config.ServerVersion),
		InstanceID: sanitizeLANText(config.InstanceID),
		AppURL:     normalizeWebAppURL(config.DaemonAppURL),
	}, nil
}

// pickServer 列出候选服务器让用户按序号选择，最后一项是手动输入地址。
// 直接回车选第一项；没有候选时直接询问地址，回车使用默认地址。
// 手动输入的地址先用 probe 测试连接，连不上会重新询问。
func pickServer(in io.Reader, out io.Writer, cands []candidate, probe func(string) bool) (string, error) {
	reader := bufio.NewReader(in)

	if len(cands) > 0 {
		printCandidates(out, cands)

		manualChoice := len(cands) + 1

		for {
			writef(out, "Choice [%d]: ", defaultChoice)

			line, err := readInputLine(reader)
			if err != nil {
				return "", err
			}

			choice, ok := parseChoice(line, manualChoice)
			if !ok {
				writef(out, "Enter a number from 1 to %d.\n", manualChoice)

				continue
			}

			if choice != manualChoice {
				return cands[choice-1].URL, nil
			}

			break
		}
	}

	return promptServerAddress(reader, out, probe)
}

// printCandidates 按名称、地址、版本分列打印候选服务器和手动输入项。
func printCandidates(out io.Writer, cands []candidate) {
	var nameWidth, hostWidth, versionWidth int

	versions := make([]string, len(cands))
	hosts := make([]string, len(cands))

	for i, c := range cands {
		hosts[i] = displayHost(c)
		if c.ServerVersion != "" {
			versions[i] = formatVersion(c.ServerVersion)
		}

		nameWidth = max(nameWidth, displayWidth(c.Name))
		hostWidth = max(hostWidth, displayWidth(hosts[i]))
		versionWidth = max(versionWidth, displayWidth(versions[i]))
	}

	indexWidth := len(strconv.Itoa(len(cands) + 1))
	gap := strings.Repeat(" ", columnGap)

	writeln(out, "? Select a server to connect to")

	for i, c := range cands {
		row := fmt.Sprintf("  %*d. %s%s%s%s%s", indexWidth, i+1,
			padRight(c.Name, nameWidth), gap,
			padRight(hosts[i], hostWidth), gap,
			padRight(versions[i], versionWidth))
		if notes := candidateNotes(c); notes != "" {
			row += gap + notes
		}

		writeln(out, strings.TrimRight(row, " "))
	}

	writef(out, "  %*d. %s\n", indexWidth, len(cands)+1, manualEntryLabel)
}

// displayHost 返回菜单里显示的主机列：有广播主机名时显示“主机名:端口”，否则显示地址里的主机和端口。
func displayHost(c candidate) string {
	if c.Host == "" {
		return hostPort(c.URL)
	}

	parsed, err := url.Parse(c.URL)
	if err != nil || parsed.Port() == "" {
		return c.Host
	}

	return net.JoinHostPort(c.Host, parsed.Port())
}

// candidateNotes 返回候选行末尾的备注：本机、桌面端正在使用。
func candidateNotes(c candidate) string {
	var notes []string

	if c.Local {
		notes = append(notes, thisComputerNote)
	}

	if c.FromDesktop {
		notes = append(notes, desktopInUseNote)
	}

	return strings.Join(notes, noteSeparator)
}

// parseChoice 把输入解析为 1..limit 的序号，空输入取默认项。
func parseChoice(input string, limit int) (int, bool) {
	input = strings.TrimSpace(input)
	if input == "" {
		return defaultChoice, true
	}

	choice, err := strconv.Atoi(input)
	if err != nil || choice < 1 || choice > limit {
		return 0, false
	}

	return choice, true
}

// promptServerAddress 询问服务器地址并测试连接，连不上时重新询问。
func promptServerAddress(reader *bufio.Reader, out io.Writer, probe func(string) bool) (string, error) {
	for {
		writef(out, "Server address [%s]: ", defaultServerAddress)

		line, err := readInputLine(reader)
		if err != nil {
			return "", err
		}

		address, ok := normalizeManualAddress(line)
		if !ok {
			writeln(out, "Enter an http:// or https:// address.")

			continue
		}

		writef(out, "Testing connection… ")

		// 每次只测试用户刚输入的一个地址，测试不通再询问下一个，只能逐个进行。
		if !probe(address) {
			writef(out, "cannot reach %s\n", address)

			continue
		}

		writeln(out, "OK")

		return address, nil
	}
}

// normalizeManualAddress 规整手动输入的服务器地址：空输入取默认地址，缺少协议时补 http://，
// 其余与 --server-url 的处理一致。不是 http(s) 地址时返回 false。
func normalizeManualAddress(input string) (string, bool) {
	input = strings.TrimSpace(input)
	if input == "" {
		input = defaultServerAddress
	}

	if !strings.Contains(input, urlSchemeSep) {
		input = urlSchemeHTTP + urlSchemeSep + input
	}

	normalized := normalizeAPIBaseURL(input)

	parsed, err := url.Parse(normalized)
	if err != nil || parsed.Host == "" {
		return "", false
	}

	if parsed.Scheme != urlSchemeHTTP && parsed.Scheme != urlSchemeHTTPS {
		return "", false
	}

	return normalized, true
}

// readInputLine 读取一行输入。输入已结束且没有内容时返回错误；
// 最后一行没有换行符时仍然返回该行。
func readInputLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		if errors.Is(err, io.EOF) {
			return "", errors.New("no server selected")
		}

		return "", errors.Wrap(err, "read server choice")
	}

	return strings.TrimSpace(line), nil
}

// padRight 用空格补齐到终端显示宽度 width。
func padRight(s string, width int) string {
	if gap := width - displayWidth(s); gap > 0 {
		return s + strings.Repeat(" ", gap)
	}

	return s
}

// displayWidth 返回字符串在终端里占的列数：中日韩文字、全角字符占两列，组合符号不占列。
func displayWidth(s string) int {
	var width int

	for _, r := range s {
		switch {
		case unicode.Is(unicode.Mn, r):
		case isWideRune(r):
			width += 2
		default:
			width++
		}
	}

	return width
}

// isWideRune 判断字符在终端里是否占两列。
func isWideRune(r rune) bool {
	for _, bounds := range wideRuneRanges {
		if r >= bounds[0] && r <= bounds[1] {
			return true
		}
	}

	return false
}
