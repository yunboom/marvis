package lark

import (
	"context"
	"log/slog"
	"time"
)

// 邀请连接的退避参数。
const (
	// defaultInviteMinBackoff 是断线后第一次重连前的等待时长。
	defaultInviteMinBackoff = time.Second

	// defaultInviteMaxBackoff 是重连等待时长的上限。
	defaultInviteMaxBackoff = time.Minute

	// inviteConnectionStableAfter 是连接算作稳定的最短存活时长，达到后退避复位。
	inviteConnectionStableAfter = time.Minute
)

// InviteRunner 是守护循环驱动的连接，*WSLongConnConnector 满足它；测试注入假实现。
type InviteRunner interface {
	// Run 阻塞到连接结束：ctx 取消时返回 nil，连接异常结束时返回错误。
	Run(ctx context.Context, inst Installation, emit EventEmitter) error
}

// InviteConnectionConfig 是 InviteConnection 的依赖与参数。
type InviteConnectionConfig struct {
	// Connector 是实际收发长连接帧的连接，通常是配了 CardHandler 的 *WSLongConnConnector。
	Connector InviteRunner

	// AppID 是邀请应用的 app_id，用来在内存里构造 Installation。
	AppID string

	// Logger 可选，默认 slog.Default。
	Logger *slog.Logger

	// MinBackoff / MaxBackoff 是断线重连的等待区间，默认 1s、60s。
	MinBackoff, MaxBackoff time.Duration
}

// InviteConnection 守护邀请应用的长连接：断线后按退避重连，直到 ctx 结束。
// 邀请应用只用来接收卡片回调，不在 installation 表里登记，也不抢租约。
type InviteConnection struct {
	connector  InviteRunner
	inst       Installation
	logger     *slog.Logger
	minBackoff time.Duration
	maxBackoff time.Duration

	// now 和 sleep 默认取真实时钟，测试替换后不必真等退避。
	now   func() time.Time
	sleep func(ctx context.Context, d time.Duration) bool
}

// NewInviteConnection 按配置构造 InviteConnection，未设置的退避参数取默认值。
func NewInviteConnection(cfg InviteConnectionConfig) *InviteConnection {
	minBackoff := cfg.MinBackoff
	if minBackoff <= 0 {
		minBackoff = defaultInviteMinBackoff
	}

	maxBackoff := cfg.MaxBackoff
	if maxBackoff <= 0 {
		maxBackoff = defaultInviteMaxBackoff
	}
	if maxBackoff < minBackoff {
		maxBackoff = minBackoff
	}

	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	return &InviteConnection{
		connector:  cfg.Connector,
		inst:       Installation{AppID: cfg.AppID},
		logger:     logger.With("app_id", cfg.AppID),
		minBackoff: minBackoff,
		maxBackoff: maxBackoff,
		now:        time.Now,
		sleep:      sleepWithContext,
	}
}

// Run 阻塞直到 ctx 结束。连接结束后按退避重连：从 MinBackoff 起步，每次翻倍，
// 不超过 MaxBackoff；某次连接存活满一分钟后退避复位到 MinBackoff。
func (c *InviteConnection) Run(ctx context.Context) {
	backoff := c.minBackoff

	for ctx.Err() == nil {
		startedAt := c.now()
		err := c.connector.Run(ctx, c.inst, discardInviteEvent)

		if ctx.Err() != nil {
			return
		}

		if c.now().Sub(startedAt) >= inviteConnectionStableAfter {
			backoff = c.minBackoff
		}

		if err != nil {
			c.logger.Warn("lark invite connection: disconnected", "err", err.Error(), "retry_in", backoff.String())
		} else {
			c.logger.Info("lark invite connection: closed by server", "retry_in", backoff.String())
		}

		if !c.sleep(ctx, backoff) {
			return
		}

		backoff = min(backoff*2, c.maxBackoff)
	}
}

// NewDropAllFrameDecoder 返回一个对所有事件帧都不处理的解码器，连接只 ACK 不分发。
// 邀请应用只关心卡片回调，事件订阅即使被误开也不会进入消息处理链路。
func NewDropAllFrameDecoder() FrameDecoder {
	return FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})
}

// discardInviteEvent 是邀请连接的 emit：解码器不产出消息，这里只是满足 Run 的签名。
func discardInviteEvent(context.Context, InboundMessage) (DispatchResult, error) {
	return DispatchResult{}, nil
}

// sleepWithContext 等待 d；等满返回 true，ctx 先结束返回 false。
func sleepWithContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()

	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
