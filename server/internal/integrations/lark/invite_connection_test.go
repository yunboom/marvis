package lark

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

// fakeInviteRunner 是注入给 InviteConnection 的假连接。run 的 n 从 1 开始，表示第几次被调用。
type fakeInviteRunner struct {
	mu     sync.Mutex
	starts []time.Time
	insts  []Installation
	run    func(ctx context.Context, n int, inst Installation, emit EventEmitter) error
}

func (f *fakeInviteRunner) Run(ctx context.Context, inst Installation, emit EventEmitter) error {
	f.mu.Lock()
	f.starts = append(f.starts, time.Now())
	f.insts = append(f.insts, inst)
	n := len(f.starts)
	f.mu.Unlock()

	return f.run(ctx, n, inst, emit)
}

func (f *fakeInviteRunner) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return len(f.starts)
}

func quietInviteConfig(runner InviteRunner) InviteConnectionConfig {
	return InviteConnectionConfig{
		Connector: runner,
		AppID:     "cli_invite",
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestInviteConnection_RetriesWithBackoff(t *testing.T) {
	t.Parallel()

	const minBackoff = 20 * time.Millisecond

	var firstReturnedAt time.Time
	secondStarted := make(chan struct{})
	runner := &fakeInviteRunner{
		run: func(ctx context.Context, n int, _ Installation, _ EventEmitter) error {
			if n == 1 {
				firstReturnedAt = time.Now()

				return errors.New("connection refused")
			}

			close(secondStarted)
			<-ctx.Done()

			return nil
		},
	}

	cfg := quietInviteConfig(runner)
	cfg.MinBackoff = minBackoff
	cfg.MaxBackoff = time.Second
	conn := NewInviteConnection(cfg)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		conn.Run(ctx)
		close(done)
	}()

	select {
	case <-secondStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("runner was not called a second time after the first failure")
	}

	runner.mu.Lock()
	secondStartedAt := runner.starts[1]
	runner.mu.Unlock()
	if gap := secondStartedAt.Sub(firstReturnedAt); gap < minBackoff {
		t.Errorf("second Run started %s after the first returned; want at least %s", gap, minBackoff)
	}

	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("InviteConnection.Run did not return after ctx cancel")
	}
}

func TestInviteConnection_RunReturnsWhenCancelledDuringBackoff(t *testing.T) {
	t.Parallel()

	called := make(chan struct{}, 1)
	runner := &fakeInviteRunner{
		run: func(context.Context, int, Installation, EventEmitter) error {
			called <- struct{}{}

			return errors.New("connection refused")
		},
	}

	cfg := quietInviteConfig(runner)
	cfg.MinBackoff = time.Hour
	cfg.MaxBackoff = time.Hour
	conn := NewInviteConnection(cfg)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		conn.Run(ctx)
		close(done)
	}()

	select {
	case <-called:
	case <-time.After(2 * time.Second):
		t.Fatal("runner was not called")
	}

	// 此时 Run 正睡在一小时的退避里，取消后必须马上返回。
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("InviteConnection.Run kept sleeping in backoff after ctx cancel")
	}

	if got := runner.callCount(); got != 1 {
		t.Errorf("runner called %d times; want 1", got)
	}
}

func TestInviteConnection_RunReturnsWithoutDialingWhenCtxAlreadyCancelled(t *testing.T) {
	t.Parallel()

	runner := &fakeInviteRunner{
		run: func(context.Context, int, Installation, EventEmitter) error {
			t.Error("runner called with an already cancelled ctx")

			return nil
		},
	}
	conn := NewInviteConnection(quietInviteConfig(runner))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		conn.Run(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("InviteConnection.Run did not return for a cancelled ctx")
	}
}

// TestInviteConnection_BackoffDoublesCapsAndResets 用假时钟和假睡眠驱动循环，
// 不依赖真实等待，验证退避翻倍、封顶，以及连上满一分钟后复位。
func TestInviteConnection_BackoffDoublesCapsAndResets(t *testing.T) {
	t.Parallel()

	var clock time.Time
	// lifetimes[i] 是第 i+1 次 Run 在假时钟上持续的时长。
	lifetimes := []time.Duration{0, 0, 0, 0, time.Minute, 0}
	runner := &fakeInviteRunner{
		run: func(_ context.Context, n int, _ Installation, _ EventEmitter) error {
			clock = clock.Add(lifetimes[n-1])
			if n == 3 {
				// 服务端正常关闭连接同样走退避重连。
				return nil
			}

			return errors.New("connection reset")
		},
	}

	cfg := quietInviteConfig(runner)
	cfg.MinBackoff = time.Second
	cfg.MaxBackoff = 4 * time.Second
	conn := NewInviteConnection(cfg)

	var delays []time.Duration
	conn.now = func() time.Time { return clock }
	conn.sleep = func(_ context.Context, d time.Duration) bool {
		delays = append(delays, d)

		return len(delays) < len(lifetimes)
	}

	conn.Run(context.Background())

	want := []time.Duration{
		time.Second,     // 第 1 次失败，从 MinBackoff 起步
		2 * time.Second, // 翻倍
		4 * time.Second, // 翻倍到上限
		4 * time.Second, // 封顶
		time.Second,     // 第 5 次连上正好一分钟，复位
		2 * time.Second, // 复位后重新翻倍
	}
	if len(delays) != len(want) {
		t.Fatalf("delays = %v; want %v", delays, want)
	}
	for i := range want {
		if delays[i] != want[i] {
			t.Errorf("delay[%d] = %s; want %s (all delays: %v)", i, delays[i], want[i], delays)
		}
	}
}

func TestInviteConnection_DefaultsAndClamp(t *testing.T) {
	t.Parallel()

	runner := &fakeInviteRunner{}

	defaults := NewInviteConnection(quietInviteConfig(runner))
	if defaults.minBackoff != time.Second || defaults.maxBackoff != time.Minute {
		t.Errorf("default backoff = %s..%s; want 1s..1m", defaults.minBackoff, defaults.maxBackoff)
	}

	cfg := quietInviteConfig(runner)
	cfg.MinBackoff = 5 * time.Minute
	clamped := NewInviteConnection(cfg)
	if clamped.maxBackoff < clamped.minBackoff {
		t.Errorf("maxBackoff %s is below minBackoff %s", clamped.maxBackoff, clamped.minBackoff)
	}
}

func TestInviteConnection_RunsWithAppIDAndDiscardsEvents(t *testing.T) {
	t.Parallel()

	type emitResult struct {
		inst Installation
		err  error
	}
	got := make(chan emitResult, 1)
	runner := &fakeInviteRunner{
		run: func(ctx context.Context, _ int, inst Installation, emit EventEmitter) error {
			_, err := emit(ctx, InboundMessage{EventID: "evt-1"})
			got <- emitResult{inst: inst, err: err}
			<-ctx.Done()

			return nil
		},
	}
	conn := NewInviteConnection(quietInviteConfig(runner))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		conn.Run(ctx)
		close(done)
	}()

	select {
	case res := <-got:
		if res.inst.AppID != "cli_invite" {
			t.Errorf("installation AppID = %q; want cli_invite", res.inst.AppID)
		}
		if res.err != nil {
			t.Errorf("emit returned %v; want nil", res.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runner was not called")
	}

	cancel()
	<-done
}

func TestDropAllFrameDecoder_NeverHandlesEvents(t *testing.T) {
	t.Parallel()

	decoder := NewDropAllFrameDecoder()

	msg, ok, err := decoder.Decode([]byte(`{"schema":"2.0","header":{"event_type":"im.message.receive_v1"}}`), Installation{AppID: "cli_invite"})
	if err != nil {
		t.Fatalf("Decode returned error: %v", err)
	}
	if ok {
		t.Errorf("Decode ok = true with msg %+v; want events dropped", msg)
	}
}
