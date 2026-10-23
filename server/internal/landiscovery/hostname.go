package landiscovery

import (
	"net"
	"strconv"
	"strings"
)

// Iface 是网卡信息的精简视图，便于在不依赖系统网卡的情况下测试地址筛选。
type Iface struct {
	// Name 是网卡名。
	Name string
	// Up 表示网卡已启用。
	Up bool
	// Loopback 表示回环网卡。
	Loopback bool
	// PointToPoint 表示点对点网卡，如 VPN 的 utun。
	PointToPoint bool
	// Addrs 是网卡上的地址。
	Addrs []net.IP
}

// AdvertiseIPs 返回应当广播的局域网地址：已启用、非回环、非点对点网卡上的私有网段 IPv4。
// 链路本地（169.254.x.x）、公网和 IPv6 地址都会被排除。
func AdvertiseIPs(ifaces []Iface) []net.IP {
	var ips []net.IP

	for _, iface := range ifaces {
		if !iface.Up || iface.Loopback || iface.PointToPoint {
			continue
		}

		for _, ip := range iface.Addrs {
			if ip.To4() == nil || !ip.IsPrivate() {
				continue
			}

			ips = append(ips, ip)
		}
	}

	return ips
}

// ChooseHostname 在已被占用的主机名之外选出 DefaultHostname 或 DefaultHostname-N。
// 比较时忽略大小写和 .local. 后缀，序号从 2 开始。
func ChooseHostname(taken []string) string {
	used := make(map[string]struct{}, len(taken))
	for _, host := range taken {
		used[strings.ToLower(trimLocal(host))] = struct{}{}
	}

	candidate := DefaultHostname
	for n := 2; ; n++ {
		if _, ok := used[candidate]; !ok {
			return candidate
		}

		candidate = DefaultHostname + "-" + strconv.Itoa(n)
	}
}
