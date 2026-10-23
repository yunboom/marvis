package landiscovery

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"
)

const (
	// hostnameProbeTimeout 是启动时探测已被占用主机名的等待时间。
	hostnameProbeTimeout = 2 * time.Second
	// rescanInterval 是重新检查网卡地址的间隔；没有局域网地址或启动失败时也按这个间隔重试。
	rescanInterval = 30 * time.Second
	// maxLabelBytes 是 DNS 单个标签的字节上限，实例名是一个标签。
	maxLabelBytes = 63
	// hostSuffix 接在广播主机名后面，得到浏览器和命令行可直接访问的名字。
	hostSuffix = ".local"
)

// errNoLANAddress 表示没有可广播的局域网地址。
var errNoLANAddress = errors.New("no private IPv4 address on any active interface")

// advertisement 是正在运行、可以撤销的广播，测试里用桩替代。
type advertisement interface {
	Stop()
	Hostname() string
}

// Status 记录局域网广播当前使用的主机名，供其他模块推导局域网地址。并发安全，零值可用。
type Status struct {
	mu       sync.RWMutex
	hostname string
}

// Hostname 返回正在广播的主机名，带 .local 后缀，如 marvis.local；没有在广播或 s 为 nil 时返回空串。
func (s *Status) Hostname() string {
	if s == nil {
		return ""
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.hostname
}

// setHostname 更新正在广播的主机名，s 为 nil 时什么也不做。
func (s *Status) setHostname(hostname string) {
	if s == nil {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.hostname = hostname
}

// Advertiser 是正在运行的局域网广播。
type Advertiser struct {
	responder *responder
	host      string
}

// Run 在局域网内广播 Marvis 服务器，直到 ctx 结束后撤销广播再返回。
// 每隔 rescanInterval 重新检查网卡：广播的地址变化时先撤销旧广播（发送 goodbye）再按新地址重新注册；
// 没有局域网地址或启动失败时记一次警告，按同样的间隔重试。只有配置不合法时返回错误。
// status 随广播的启停更新为实际使用的主机名，可为 nil。
func Run(ctx context.Context, cfg Config, serverVersion, instanceID string, status *Status) error {
	if cfg.Port <= 0 || cfg.Port > maxPort {
		return errors.Errorf("invalid lan discovery port=%d", cfg.Port)
	}

	ticker := time.NewTicker(rescanInterval)
	defer ticker.Stop()

	loop := &advertLoop{
		scan: scanLANInterfaces,
		start: func(ctx context.Context, ifaces []lanIface) (advertisement, error) {
			return start(ctx, cfg, serverVersion, instanceID, ifaces)
		},
		status: status,
	}
	loop.run(ctx, ticker.C)

	return nil
}

// advertLoop 让广播跟随网卡地址的变化。
type advertLoop struct {
	// scan 返回当前可广播的网卡和地址。
	scan func() ([]lanIface, error)
	// start 在给定网卡上开始广播。
	start func(ctx context.Context, ifaces []lanIface) (advertisement, error)
	// status 记录正在广播的主机名，可为 nil。
	status *Status

	// current 是正在运行的广播，key 是它使用的地址集合。
	current advertisement
	key     string
	// problem 是最近一次记录的警告，同一个问题只记一次。
	problem string
}

// run 先检查一次，之后每收到一次 tick 再检查；ctx 结束时撤销广播并返回。
func (l *advertLoop) run(ctx context.Context, ticks <-chan time.Time) {
	defer l.stopCurrent()

	for {
		l.reconcile(ctx)

		select {
		case <-ctx.Done():
			return
		case <-ticks:
		}
	}
}

// reconcile 对比当前地址与正在广播的地址，不一致时撤销旧广播并按新地址重新开始。
func (l *advertLoop) reconcile(ctx context.Context) {
	ifaces, err := l.scan()
	if err != nil {
		l.warn("lan discovery: unable to list network interfaces", err)

		return
	}

	key := addressKey(ifaces)
	if l.current != nil && key == l.key {
		return
	}

	if l.current != nil {
		slog.Info("lan discovery: network addresses changed, re-advertising", "from", l.key, "to", key)
		l.stopCurrent()
	}

	if len(ifaces) == 0 {
		l.warn("lan discovery: no LAN address yet, will retry", errNoLANAddress)

		return
	}

	advert, err := l.start(ctx, ifaces)
	if err != nil {
		// 服务端正在退出时启动被取消，不算问题。
		if ctx.Err() == nil {
			l.warn("lan discovery unavailable, will retry", err)
		}

		return
	}

	l.current, l.key, l.problem = advert, key, ""
	l.status.setHostname(advert.Hostname())
}

// stopCurrent 撤销正在运行的广播。
func (l *advertLoop) stopCurrent() {
	if l.current == nil {
		return
	}

	l.current.Stop()
	l.current, l.key = nil, ""
	l.status.setHostname("")
}

// warn 记录警告；与上一次相同的问题不重复记录，避免每次重试都刷日志。
func (l *advertLoop) warn(msg string, err error) {
	problem := msg + ": " + err.Error()
	if problem == l.problem {
		return
	}

	l.problem = problem
	slog.Warn(msg, "error", err, "retry_in", rescanInterval)
}

// addressKey 把网卡和地址拼成与顺序无关的字符串，用来判断地址是否变化。
func addressKey(ifaces []lanIface) string {
	parts := make([]string, 0, len(ifaces))

	for _, li := range ifaces {
		ips := make([]string, 0, len(li.ips))
		for _, ip := range li.ips {
			ips = append(ips, ip.String())
		}

		parts = append(parts, li.iface.Name+"="+strings.Join(ips, ","))
	}

	sort.Strings(parts)

	return strings.Join(parts, ";")
}

// start 探测局域网内其他实例占用的主机名，选定 marvis 或 marvis-N 后在给定网卡上开始应答。
// ctx 只约束探测，广播的生命周期由 Stop 控制。
func start(ctx context.Context, cfg Config, serverVersion, instanceID string, ifaces []lanIface) (*Advertiser, error) {
	entries, err := Browse(ctx, hostnameProbeTimeout)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	// 探测期间被取消时不再注册，避免退出过程中又冒出一条广播。
	if err := ctx.Err(); err != nil {
		return nil, errors.WithStack(err)
	}

	host := ChooseHostname(takenHosts(entries, instanceID))

	r, err := startResponder(newServiceRecords(cfg, host, serverVersion, instanceID), ifaces)
	if err != nil {
		return nil, errors.WithMessagef(err, "start mdns responder host=%s port=%d", host, cfg.Port)
	}

	advertiser := &Advertiser{responder: r, host: host}
	slog.Info("lan discovery started", "host", advertiser.Hostname(), "port", cfg.Port, "addresses", addressKey(ifaces))

	return advertiser, nil
}

// Hostname 返回广播的主机名，带 .local 后缀，如 marvis.local。
func (a *Advertiser) Hostname() string {
	return a.host + hostSuffix
}

// Stop 撤销广播并释放网络资源，可重复调用。
func (a *Advertiser) Stop() {
	if a == nil {
		return
	}

	a.responder.Stop()
}

// scanLANInterfaces 返回本机当前可广播的网卡和地址。
func scanLANInterfaces() ([]lanIface, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, errors.WithStack(err)
	}

	return lanInterfaces(ifaces, func(iface net.Interface) ([]net.Addr, error) {
		return iface.Addrs()
	})
}

// lanInterfaces 返回带有可广播地址、支持组播的网卡，每块网卡只带自己的地址，筛选规则同 AdvertiseIPs。
// addrsOf 取网卡上的地址，单独传入以便在不依赖系统网卡的情况下测试。
func lanInterfaces(ifaces []net.Interface, addrsOf func(net.Interface) ([]net.Addr, error)) ([]lanIface, error) {
	var lanIfaces []lanIface

	for _, iface := range ifaces {
		if iface.Flags&net.FlagMulticast == 0 {
			continue
		}

		addrs, err := addrsOf(iface)
		if err != nil {
			return nil, errors.Wrapf(err, "list addresses of interface %s", iface.Name)
		}

		ips := AdvertiseIPs([]Iface{ifaceView(iface, addrs)})
		if len(ips) == 0 {
			continue
		}

		lanIfaces = append(lanIfaces, lanIface{iface: iface, ips: ips})
	}

	return lanIfaces, nil
}

// ifaceView 把系统网卡转成 AdvertiseIPs 使用的精简视图。
func ifaceView(iface net.Interface, addrs []net.Addr) Iface {
	view := Iface{
		Name:         iface.Name,
		Up:           iface.Flags&net.FlagUp != 0,
		Loopback:     iface.Flags&net.FlagLoopback != 0,
		PointToPoint: iface.Flags&net.FlagPointToPoint != 0,
	}

	for _, addr := range addrs {
		switch a := addr.(type) {
		case *net.IPNet:
			view.Addrs = append(view.Addrs, a.IP)
		case *net.IPAddr:
			view.Addrs = append(view.Addrs, a.IP)
		}
	}

	return view
}

// takenHosts 返回其他实例占用的主机名，本实例自己的记录不算。
func takenHosts(entries []Entry, selfInstanceID string) []string {
	var hosts []string

	for _, entry := range entries {
		if entry.InstanceID == selfInstanceID || entry.Host == "" {
			continue
		}

		hosts = append(hosts, entry.Host)
	}

	return hosts
}

// instanceLabel 把服务器名称转成 DNS-SD 实例名：去掉首尾的点，按 63 字节上限在字符边界截断，
// 再按 DNS 域名规则转义。服务端用这个字符串匹配收到的实例查询，必须与解包后的写法一致。
func instanceLabel(name string) string {
	name = truncateUTF8(strings.Trim(strings.TrimSpace(name), "."), maxLabelBytes)
	if name == "" {
		name = DefaultHostname
	}

	var label strings.Builder
	for i := 0; i < len(name); i++ {
		b := name[i]

		switch {
		case isLabelSpecial(b):
			label.WriteByte('\\')
			label.WriteByte(b)
		case b < ' ' || b > '~':
			_, _ = fmt.Fprintf(&label, "\\%03d", b)
		default:
			label.WriteByte(b)
		}
	}

	return label.String()
}

// isLabelSpecial 判断字符在域名标签里是否需要用反斜杠转义。
func isLabelSpecial(b byte) bool {
	switch b {
	case '.', ' ', '\'', '@', ';', '(', ')', '"', '\\':
		return true
	}

	return false
}

// wireTXT 转义 TXT 记录里的反斜杠，DNS 库打包时把反斜杠当作转义符。
func wireTXT(records []string) []string {
	wire := make([]string, 0, len(records))
	for _, record := range records {
		wire = append(wire, strings.ReplaceAll(record, `\`, `\\`))
	}

	return wire
}
