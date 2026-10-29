package util

import (
	"os"
	"strings"
)

// 网页端地址相关的环境变量。
const (
	// basePathEnv 是网页端的路径前缀（如 /marvis）。前端构建和后端拼链接共用这一个变量，改前缀只改它。
	basePathEnv = "MARVIS_BASE_PATH"
	// appURLEnv 是网页端对外的协议和域名，不含路径前缀。
	appURLEnv = "MARVIS_APP_URL"
	// frontendOriginEnv 是 appURLEnv 未设置时的回退，同样只有协议和域名。
	frontendOriginEnv = "FRONTEND_ORIGIN"
)

// BasePathFromEnv 返回规范化后的路径前缀：去掉首尾斜杠后补一个前导斜杠，未设置时为空串。
// 规则与 apps/web/config/base-path.ts 的 normalizeBasePath 一致。
func BasePathFromEnv() string {
	trimmed := strings.Trim(strings.TrimSpace(os.Getenv(basePathEnv)), "/")
	if trimmed == "" {
		return ""
	}

	return "/" + trimmed
}

// AppURLFromEnv 返回网页端对外的完整地址：MARVIS_APP_URL（未设置时为 FRONTEND_ORIGIN）去掉末尾斜杠，
// 再加上 MARVIS_BASE_PATH。两者都没配置时返回空串。
func AppURLFromEnv() string {
	origin := strings.TrimRight(strings.TrimSpace(os.Getenv(appURLEnv)), "/")
	if origin == "" {
		origin = strings.TrimRight(strings.TrimSpace(os.Getenv(frontendOriginEnv)), "/")
	}
	if origin == "" {
		return ""
	}

	return origin + BasePathFromEnv()
}
