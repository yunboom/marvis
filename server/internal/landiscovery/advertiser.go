package landiscovery

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/libp2p/zeroconf/v2"
	"github.com/pkg/errors"
)

const (
	// hostnameProbeTimeout 是启动时探测已被占用主机名的等待时间。
	hostnameProbeTimeout = 2 * time.Second
	// maxLabelBytes 是 DNS 单个标签的字节上限，实例名是一个标签。
	maxLabelBytes = 63
	// hostSuffix 接在广播主机名后面，得到浏览器和命令行可直接访问的名字。
	hostSuffix = ".local"
)

// errNoLANAddress 表示没有可广播的局域网地址。
var errNoLANAddress = errors.New("no private IPv4 address on any active interface")

// Advertiser 是正在运行的局域网广播。
type Advertiser struct {
	server   *zeroconf.Server
	host     string
	stopOnce sync.Once
}

// Start 开始在局域网内广播 Marvis 服务器。
// 先探测局域网内其他实例占用的主机名，再以 marvis 或 marvis-N 注册服务；
// ctx 只约束启动阶段的探测，广播的生命周期由 Stop 控制。
func Start(ctx context.Context, cfg Config, serverVersion, instanceID string) (*Advertiser, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, errors.WithStack(err)
	}

	lanIfaces, ips, err := lanInterfaces(ifaces, func(iface net.Interface) ([]net.Addr, error) {
		return iface.Addrs()
	})
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, errNoLANAddress
	}

	entries, err := Browse(ctx, hostnameProbeTimeout)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	// 探测期间被取消时不再注册，避免退出过程中又冒出一条广播。
	if err := ctx.Err(); err != nil {
		return nil, errors.WithStack(err)
	}
	host := ChooseHostname(takenHosts(entries, instanceID))

	ipStrings := make([]string, 0, len(ips))
	for _, ip := range ips {
		ipStrings = append(ipStrings, ip.String())
	}

	txt := wireTXT(TXTRecords(cfg.Name, serverVersion, instanceID))
	server, err := zeroconf.RegisterProxy(instanceLabel(cfg.Name), ServiceType, Domain, cfg.Port, host, ipStrings, txt, lanIfaces)
	if err != nil {
		return nil, errors.Wrapf(err, "register mdns service host=%s port=%d", host, cfg.Port)
	}

	advertiser := &Advertiser{server: server, host: host}
	slog.Info("lan discovery started", "host", advertiser.Hostname(), "port", cfg.Port)

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

	a.stopOnce.Do(a.server.Shutdown)
}

// lanInterfaces 返回带有可广播地址的网卡和这些网卡上的地址，筛选规则同 AdvertiseIPs。
// addrsOf 取网卡上的地址，单独传入以便在不依赖系统网卡的情况下测试。
func lanInterfaces(ifaces []net.Interface, addrsOf func(net.Interface) ([]net.Addr, error)) ([]net.Interface, []net.IP, error) {
	var (
		lanIfaces []net.Interface
		ips       []net.IP
	)

	for _, iface := range ifaces {
		addrs, err := addrsOf(iface)
		if err != nil {
			return nil, nil, errors.Wrapf(err, "list addresses of interface %s", iface.Name)
		}

		ifaceIPs := AdvertiseIPs([]Iface{ifaceView(iface, addrs)})
		if len(ifaceIPs) == 0 {
			continue
		}

		lanIfaces = append(lanIfaces, iface)
		ips = append(ips, ifaceIPs...)
	}

	return lanIfaces, ips, nil
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

// wireTXT 转义 TXT 记录里的反斜杠，zeroconf 打包时把反斜杠当作转义符。
func wireTXT(records []string) []string {
	wire := make([]string, 0, len(records))
	for _, record := range records {
		wire = append(wire, strings.ReplaceAll(record, `\`, `\\`))
	}

	return wire
}
