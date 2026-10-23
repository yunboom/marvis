package main

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yunboom/marvis/server/internal/landiscovery"
)

// lanInstanceIDTimeout 是读取实例 ID 的超时，数据库刚就绪，正常几毫秒即可返回。
const lanInstanceIDTimeout = 5 * time.Second

// lanConfigForListenPort 把广播端口设为服务端实际监听的端口，两者来自同一个值，不会分叉。
// port 无法解析时保留 cfg 里的端口，此时服务端自己也无法监听，会在启动时退出。
func lanConfigForListenPort(cfg landiscovery.Config, port string) landiscovery.Config {
	if listenPort, err := strconv.Atoi(port); err == nil {
		cfg.Port = listenPort
	}

	return cfg
}

// loadLANInstanceID 读取本部署的实例 ID。
// 读取失败只记警告并返回空串：/api/config 不下发 instance_id，也不广播，服务端照常启动。
func loadLANInstanceID(ctx context.Context, pool *pgxpool.Pool) string {
	ctx, cancel := context.WithTimeout(ctx, lanInstanceIDTimeout)
	defer cancel()

	instanceID, err := landiscovery.LoadInstanceID(ctx, pool)
	if err != nil {
		slog.Warn("lan discovery: unable to load instance id", "error", err)

		return ""
	}

	return instanceID
}

// lanAdvertising 管理在后台运行的局域网广播。
// 启动阶段要探测局域网内已占用的主机名，耗时数秒，之后还要跟随网卡地址的变化，所以放在后台运行。
type lanAdvertising struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// startLANAdvertising 在后台开始广播。关闭广播或没有实例 ID 时返回 nil；
// 广播出错只记警告，不影响服务端。status 随广播启停更新为实际使用的主机名。
func startLANAdvertising(cfg landiscovery.Config, serverVersion, instanceID string, status *landiscovery.Status) *lanAdvertising {
	if !cfg.Enabled || instanceID == "" {
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	lan := &lanAdvertising{cancel: cancel, done: make(chan struct{})}

	go func() {
		defer close(lan.done)

		if err := landiscovery.Run(ctx, cfg, serverVersion, instanceID, status); err != nil {
			slog.Warn("lan discovery unavailable", "error", err)
		}
	}()

	return lan
}

// Stop 撤销广播并等待后台协程退出，lan 为 nil 时什么也不做。
func (lan *lanAdvertising) Stop() {
	if lan == nil {
		return
	}

	lan.cancel()
	<-lan.done
}
