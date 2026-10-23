package cli

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	// desktopDataDirName 是桌面端数据目录名，与 Electron 的 app name 一致。
	desktopDataDirName = "Marvis"
	// desktopServerFileName 是桌面端写入已选服务器的文件名。
	desktopServerFileName = "server.json"

	schemeHTTP  = "http"
	schemeHTTPS = "https"

	portHTTP  = "80"
	portHTTPS = "443"
)

// DesktopServer 是桌面端当前选用的服务器，来自桌面端写入的 server.json。
// 文件里还有 source、appUrl 两个键，命令行不使用。
type DesktopServer struct {
	URL        string `json:"url"`
	Name       string `json:"name"`
	InstanceID string `json:"instanceId"`
}

// ReadDesktopSelectedServer 读取桌面端已选的服务器，只读不写。
// configDir 是用户配置目录，生产调用传 os.UserConfigDir() 的结果；
// 文件位于 <configDir>/Marvis/server.json。
// 文件不存在、内容损坏或地址不合法时返回 false，按桌面端未选择处理。
// 返回的 URL 已规整为 scheme://host[:port]。
func ReadDesktopSelectedServer(configDir string) (DesktopServer, bool) {
	if configDir == "" {
		return DesktopServer{}, false
	}

	data, err := os.ReadFile(filepath.Join(configDir, desktopDataDirName, desktopServerFileName))
	if err != nil {
		return DesktopServer{}, false
	}

	var selected DesktopServer
	if err := json.Unmarshal(data, &selected); err != nil {
		return DesktopServer{}, false
	}

	origin, ok := normalizeServerOrigin(selected.URL)
	if !ok {
		return DesktopServer{}, false
	}

	selected.URL = origin
	selected.Name = strings.TrimSpace(selected.Name)
	selected.InstanceID = strings.TrimSpace(selected.InstanceID)

	return selected, true
}

// normalizeServerOrigin 把地址规整为 scheme://host[:port]：缺少协议时补 http://，
// 丢弃路径、查询串、片段和账号信息，主机名转小写，省略协议默认端口。
// 规则与桌面端 normalizeServerAddress 一致；不是合法的 http(s) 地址时返回 false。
func normalizeServerOrigin(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false
	}

	if !strings.Contains(raw, "://") {
		raw = schemeHTTP + "://" + raw
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return "", false
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme != schemeHTTP && scheme != schemeHTTPS {
		return "", false
	}

	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" {
		return "", false
	}

	// IPv6 字面量在地址里要带方括号。
	host := hostname
	if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}

	port := parsed.Port()
	isDefaultPort := (scheme == schemeHTTP && port == portHTTP) || (scheme == schemeHTTPS && port == portHTTPS)
	if port != "" && !isDefaultPort {
		host += ":" + port
	}

	return scheme + "://" + host, true
}
