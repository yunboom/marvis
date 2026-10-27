package landiscovery

import (
	"context"
	"net"
	"strings"
	"time"

	"github.com/libp2p/zeroconf/v2"
	"github.com/pkg/errors"
)

// Entry 是在局域网内发现的一台 Marvis 服务器。
// 只是候选，必须经 /api/config 核实后才能连接。
type Entry struct {
	// Instance 是 DNS-SD 实例名。
	Instance string
	// Name 是 TXT 里的服务器名称，缺失时取 Instance。
	Name string
	// ServerVersion 是服务端版本号，来自 TXT 的 ver。
	ServerVersion string
	// InstanceID 是实例 ID，来自 TXT 的 id。
	InstanceID string
	// Host 是广播的主机名，形如 marvis.local.。
	Host string
	// Port 是服务端口。
	Port int
	// IPs 是主机的地址，IPv4 在前。
	IPs []net.IP
}

// Browse 在局域网内查找 Marvis 服务器，等待 timeout 或 ctx 结束后返回已发现的结果。
// 协议版本与本包不一致的记录会被跳过。
func Browse(ctx context.Context, timeout time.Duration) ([]Entry, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var (
		services = make(chan *zeroconf.ServiceEntry)
		stop     = make(chan struct{})
		done     = make(chan struct{})
		entries  []Entry
	)

	// 必须持续消费 services，否则 zeroconf 的收包循环会阻塞在发送上。
	go func() {
		defer close(done)

		for {
			select {
			case svc, ok := <-services:
				if !ok {
					return
				}

				if entry, valid := entryFromService(svc); valid {
					entries = append(entries, entry)
				}
			case <-stop:
				return
			}
		}
	}()

	err := zeroconf.Browse(ctx, ServiceType, Domain, services)

	// Browse 返回后 zeroconf 不会再发送；出错时 services 可能未关闭，用 stop 结束消费协程。
	close(stop)
	<-done

	if err != nil {
		return nil, errors.Wrapf(err, "browse mdns service=%s", ServiceType)
	}

	return entries, nil
}

// entryFromService 把 zeroconf 解出的记录转成 Entry，协议版本不匹配时返回 false。
func entryFromService(svc *zeroconf.ServiceEntry) (Entry, bool) {
	txt := parseTXT(svc.Text)
	if txt[TXTKeyVersion] != ProtocolVersion {
		return Entry{}, false
	}

	entry := Entry{
		Instance:      unescapeDNS(svc.Instance),
		Name:          txt[TXTKeyName],
		ServerVersion: txt[TXTKeyServerVersion],
		InstanceID:    txt[TXTKeyInstanceID],
		Host:          svc.HostName,
		Port:          svc.Port,
		IPs:           append(append([]net.IP{}, svc.AddrIPv4...), svc.AddrIPv6...),
	}
	if entry.Name == "" {
		entry.Name = entry.Instance
	}

	return entry, true
}

// parseTXT 把 key=value 形式的 TXT 记录解成 map，键按小写处理，值先反转义。
func parseTXT(records []string) map[string]string {
	txt := make(map[string]string, len(records))

	for _, record := range records {
		key, value, found := strings.Cut(unescapeDNS(record), "=")
		if !found {
			continue
		}

		key = strings.ToLower(key)
		if _, exists := txt[key]; !exists {
			txt[key] = value
		}
	}

	return txt
}

// unescapeDNS 还原 DNS 库解包时的转义：\DDD 是十进制字节，\X 是字符 X 本身。
// 非 ASCII 字符（如中文服务器名称）在解包结果里都以 \DDD 形式出现。
func unescapeDNS(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}

	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 >= len(s) {
			out.WriteByte(s[i])

			continue
		}

		if i+3 < len(s) && isDigit(s[i+1]) && isDigit(s[i+2]) && isDigit(s[i+3]) {
			if value := int(s[i+1]-'0')*100 + int(s[i+2]-'0')*10 + int(s[i+3]-'0'); value <= 255 {
				out.WriteByte(byte(value))
				i += 3

				continue
			}
		}

		i++
		out.WriteByte(s[i])
	}

	return out.String()
}

// isDigit 判断是否为十进制数字。
func isDigit(b byte) bool {
	return b >= '0' && b <= '9'
}
