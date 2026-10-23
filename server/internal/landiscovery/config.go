// Package landiscovery 在局域网内广播 Marvis 服务器，让桌面端、命令行和浏览器能找到它。
package landiscovery

import (
	"fmt"
	"strconv"
	"strings"
)

// 广播协议的固定取值。
const (
	// ServiceType 是 DNS-SD 服务类型。
	ServiceType = "_marvis._tcp"
	// Domain 是 mDNS 域。
	Domain = "local."
	// ProtocolVersion 是 TXT 记录里 v 字段的协议版本。
	ProtocolVersion = "1"
	// DefaultHostname 是广播的主机名，冲突时由 ChooseHostname 追加序号。
	DefaultHostname = "marvis"
	// DefaultFrontendPort 是 FRONTEND_PORT 未设置时的网页端口。
	DefaultFrontendPort = 3000
)

// TXT 记录的键。
const (
	// TXTKeyVersion 是协议版本。
	TXTKeyVersion = "v"
	// TXTKeyName 是服务器名称。
	TXTKeyName = "name"
	// TXTKeyServerVersion 是服务端版本号。
	TXTKeyServerVersion = "ver"
	// TXTKeyInstanceID 是实例 ID。
	TXTKeyInstanceID = "id"
)

// 服务端读取的环境变量名。
const (
	envDiscovery    = "MARVIS_LAN_DISCOVERY"
	envName         = "MARVIS_LAN_NAME"
	envFrontendPort = "FRONTEND_PORT"
)

const (
	// localSuffix 是 mDNS 主机名和电脑名上常见的后缀。
	localSuffix = ".local"
	// maxPort 是 TCP 端口号上限。
	maxPort = 65535
)

// Config 是服务端广播的配置。
type Config struct {
	// Enabled 为 false 时不广播。
	Enabled bool
	// Name 是展示给用户的服务器名称。
	Name string
	// Port 是网页端口。
	Port int
}

// ConfigFromEnv 从环境变量读取广播配置。
// MARVIS_LAN_DISCOVERY 为 false 时关闭广播，默认开启；
// MARVIS_LAN_NAME 为空时取电脑名并去掉 .local 后缀；
// 端口取 FRONTEND_PORT，缺失或非法时用 DefaultFrontendPort。
func ConfigFromEnv(getenv func(string) string, hostname func() (string, error)) Config {
	cfg := Config{
		Enabled: true,
		Name:    strings.TrimSpace(getenv(envName)),
		Port:    DefaultFrontendPort,
	}

	if enabled, err := strconv.ParseBool(strings.TrimSpace(getenv(envDiscovery))); err == nil {
		cfg.Enabled = enabled
	}

	if cfg.Name == "" {
		cfg.Name = defaultName(hostname)
	}

	if port, err := strconv.Atoi(strings.TrimSpace(getenv(envFrontendPort))); err == nil && port > 0 && port <= maxPort {
		cfg.Port = port
	}

	return cfg
}

// defaultName 取电脑名作为服务器名称，取不到时退回 DefaultHostname。
func defaultName(hostname func() (string, error)) string {
	host, err := hostname()
	if err != nil {
		return DefaultHostname
	}

	name := trimLocal(host)
	if name == "" {
		return DefaultHostname
	}

	return name
}

// trimLocal 去掉名字两端空白、末尾的点和 .local 后缀，后缀按大小写不敏感处理。
func trimLocal(name string) string {
	name = strings.TrimSuffix(strings.TrimSpace(name), ".")
	if len(name) >= len(localSuffix) && strings.EqualFold(name[len(name)-len(localSuffix):], localSuffix) {
		name = name[:len(name)-len(localSuffix)]
	}

	return name
}

// TXTRecords 返回 key=value 形式的 TXT 记录，顺序为 v、name、ver、id。
func TXTRecords(name, serverVersion, instanceID string) []string {
	return []string{
		txtRecord(TXTKeyVersion, ProtocolVersion),
		txtRecord(TXTKeyName, name),
		txtRecord(TXTKeyServerVersion, serverVersion),
		txtRecord(TXTKeyInstanceID, instanceID),
	}
}

// txtRecord 拼出一条 key=value 记录。
func txtRecord(key, value string) string {
	return fmt.Sprintf("%s=%s", key, value)
}
