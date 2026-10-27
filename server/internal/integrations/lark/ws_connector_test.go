package lark

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeWSConn is a programmable WSConn driven by tests. ReadMessage
// blocks until either Push delivers a frame or Close is invoked —
// this is how we simulate the "blocked in TCP read" condition the
// watchdog has to break.
//
// Frames sent via WriteMessage are buffered into writes[] so tests
// can assert on outbound traffic (ACK, ping) without race conditions.
type fakeWSConn struct {
	mu     sync.Mutex
	writes [][]byte

	frames    chan []byte
	closeOnce sync.Once
	closed    chan struct{}
	writeErr  error // optional injection for WriteMessage
}

func newFakeWSConn() *fakeWSConn {
	return &fakeWSConn{
		frames: make(chan []byte, 16),
		closed: make(chan struct{}),
	}
}

// Push enqueues a binary frame for the next ReadMessage call.
func (f *fakeWSConn) Push(b []byte) {
	select {
	case f.frames <- b:
	case <-f.closed:
	}
}

func (f *fakeWSConn) ReadMessage() (int, []byte, error) {
	select {
	case b, ok := <-f.frames:
		if !ok {
			return 0, nil, io.EOF
		}
		return websocket.BinaryMessage, b, nil
	case <-f.closed:
		return 0, nil, &websocket.CloseError{Code: websocket.CloseAbnormalClosure, Text: "fake closed"}
	}
}

func (f *fakeWSConn) WriteMessage(messageType int, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.writeErr != nil {
		return f.writeErr
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	f.writes = append(f.writes, cp)
	return nil
}

func (f *fakeWSConn) SetReadDeadline(t time.Time) error  { return nil }
func (f *fakeWSConn) SetWriteDeadline(t time.Time) error { return nil }

func (f *fakeWSConn) Close() error {
	f.closeOnce.Do(func() {
		close(f.closed)
	})
	return nil
}

func (f *fakeWSConn) snapshot() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]byte, len(f.writes))
	for i, w := range f.writes {
		out[i] = append([]byte(nil), w...)
	}
	return out
}

// fakeWSDialer hands back a pre-built fakeWSConn so tests can drive
// frames + observe closes deterministically.
type fakeWSDialer struct {
	conn    *fakeWSConn
	dialErr error
}

func (d *fakeWSDialer) DialContext(ctx context.Context, urlStr string, h http.Header) (WSConn, *http.Response, error) {
	if d.dialErr != nil {
		return nil, nil, d.dialErr
	}
	return d.conn, nil, nil
}

// syncBuffer is a mutex-guarded io.Writer, so a slog handler written
// from the connector goroutine can be read from the test goroutine.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// quietConnector wires a connector with a deterministic decoder + the
// fakeWSConn. Caller controls the decoder so each test can assert
// per-payload behaviour.
func quietConnector(t *testing.T, conn *fakeWSConn, decoder FrameDecoder, pingInterval time.Duration) *WSLongConnConnector {
	t.Helper()
	return connectorWithLogger(t, conn, decoder, pingInterval, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// connectorWithLogger is quietConnector with the logger left to the
// caller, for the tests that assert on what the connector logs.
func connectorWithLogger(t *testing.T, conn *fakeWSConn, decoder FrameDecoder, pingInterval time.Duration, logger *slog.Logger) *WSLongConnConnector {
	t.Helper()
	c, err := NewWSLongConnConnector(WSConnectorConfig{
		Dialer: &fakeWSDialer{conn: conn},
		EndpointFetcher: EndpointFetcherFunc(func(context.Context, InstallationCredentials) (WSEndpoint, error) {
			return WSEndpoint{URL: "wss://test/ignored", ServiceID: 7, PingInterval: pingInterval}, nil
		}),
		FrameDecoder: decoder,
		CredentialsProvider: CredentialsProviderFunc(func(context.Context, Installation) (InstallationCredentials, error) {
			return InstallationCredentials{AppID: "test_app", AppSecret: "secret"}, nil
		}),
		PingInterval: pingInterval,
		ReadDeadline: time.Second,
		WriteTimeout: time.Second,
		Logger:       logger,
	})
	if err != nil {
		t.Fatalf("NewWSLongConnConnector: %v", err)
	}
	return c
}

// pushDataFrame writes a Lark long-conn data Frame envelope wrapping
// the supplied JSON payload onto the conn's read queue.
func pushDataFrame(conn *fakeWSConn, payload []byte, messageID string) {
	f := &Frame{
		Method:  FrameMethodData,
		Service: 7,
		Headers: []FrameHeader{
			{Key: FrameHeaderTypeKey, Value: FrameHeaderTypeEvent},
			{Key: FrameHeaderMessageIDKey, Value: messageID},
		},
		Payload: payload,
	}
	conn.Push(f.Marshal())
}

func TestWSConnectorRunReturnsOnCtxCancelEvenWhenReadIsBlocked(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})
	c := quietConnector(t, conn, decoder, 10*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			t.Errorf("emit unexpectedly called")
			return DispatchResult{}, nil
		})
	}()

	// Give the connector a moment to dial + park in ReadMessage.
	time.Sleep(20 * time.Millisecond)

	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned error on ctx cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return within 2s of ctx cancel — watchdog broken")
	}
}

// TestWSConnectorEmitsDecodedFramesAndAcks verifies that:
//   - data frames whose decoder returns ok=true reach emit;
//   - every data frame yields an ACK Frame written back to the conn;
//   - heartbeat / non-event payloads are dropped but still ACKed (so
//     the server stops resending them).
func TestWSConnectorEmitsDecodedFramesAndAcks(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	decoder := FrameDecoderFunc(func(payload []byte, _ Installation) (InboundMessage, bool, error) {
		if string(payload) == "heartbeat" {
			return InboundMessage{}, false, nil
		}
		return InboundMessage{
			EventID:   string(payload),
			AppID:     "test_app",
			MessageID: "msg-" + string(payload),
		}, true, nil
	})
	c := quietConnector(t, conn, decoder, time.Hour) // disable ping cadence

	var emitted []InboundMessage
	var emitMu sync.Mutex
	emit := func(_ context.Context, msg InboundMessage) (DispatchResult, error) {
		emitMu.Lock()
		emitted = append(emitted, msg)
		emitMu.Unlock()
		return DispatchResult{Outcome: OutcomeIngested}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, emit)
	}()

	pushDataFrame(conn, []byte("evt-1"), "m1")
	pushDataFrame(conn, []byte("heartbeat"), "m2")
	pushDataFrame(conn, []byte("evt-2"), "m3")

	deadline := time.After(2 * time.Second)
	for {
		emitMu.Lock()
		n := len(emitted)
		emitMu.Unlock()
		if n >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("only %d emits in 2s", n)
		case <-time.After(5 * time.Millisecond):
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancel")
	}

	if emitted[0].EventID != "evt-1" || emitted[1].EventID != "evt-2" {
		t.Errorf("emit ordering wrong: %+v", emitted)
	}

	// Every data frame should have produced an ACK frame on the wire
	// regardless of decode outcome (drop or emit).
	writes := conn.snapshot()
	if len(writes) < 3 {
		t.Fatalf("expected >=3 outbound ACK frames, got %d", len(writes))
	}
	for i, w := range writes[:3] {
		f, err := UnmarshalFrame(w)
		if err != nil {
			t.Fatalf("write[%d] unmarshal: %v", i, err)
		}
		if f.Method != FrameMethodData {
			t.Errorf("ack[%d] Method = %d; want Data", i, f.Method)
		}
		if f.HeaderValue(FrameHeaderTypeKey) != FrameHeaderTypeEvent {
			t.Errorf("ack[%d] type header = %q", i, f.HeaderValue(FrameHeaderTypeKey))
		}
		if len(f.Payload) == 0 || !contains(string(f.Payload), `"code":200`) {
			t.Errorf("ack[%d] payload missing code=200: %s", i, string(f.Payload))
		}
	}
}

func TestWSConnectorRespondsToServerPingWithPong(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})
	c := quietConnector(t, conn, decoder, time.Hour)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, nil
		})
	}()

	// Server-initiated ping (control frame, type=ping).
	pingFrame := &Frame{
		Method:  FrameMethodControl,
		Service: 7,
		Headers: []FrameHeader{{Key: FrameHeaderTypeKey, Value: FrameHeaderTypePing}},
	}
	conn.Push(pingFrame.Marshal())

	// Allow the read loop to react.
	deadline := time.After(2 * time.Second)
	for {
		writes := conn.snapshot()
		if len(writes) >= 1 {
			f, err := UnmarshalFrame(writes[0])
			if err != nil {
				t.Fatalf("pong unmarshal: %v", err)
			}
			if f.HeaderValue(FrameHeaderTypeKey) != FrameHeaderTypePong {
				t.Errorf("response type = %q; want pong", f.HeaderValue(FrameHeaderTypeKey))
			}
			if f.Service != 7 {
				t.Errorf("response Service = %d; want 7", f.Service)
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("connector did not pong in 2s")
		case <-time.After(5 * time.Millisecond):
		}
	}

	cancel()
	<-done
}

func TestWSConnectorEmitInfraErrorSendsNackAndReturns(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{EventID: "x"}, true, nil
	})
	c := quietConnector(t, conn, decoder, time.Hour)

	infra := errors.New("dispatcher infra failure")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, infra
		})
	}()

	pushDataFrame(conn, []byte("triggers-infra"), "m-infra")

	select {
	case err := <-done:
		if err == nil || !errors.Is(err, infra) {
			t.Fatalf("expected Run to wrap infra error, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after infra error")
	}

	// NACK should have been written on the way out (code=500).
	writes := conn.snapshot()
	found := false
	for _, w := range writes {
		f, err := UnmarshalFrame(w)
		if err != nil {
			continue
		}
		if f.Method == FrameMethodData && contains(string(f.Payload), `"code":500`) {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected NACK (code=500) frame written on infra error path")
	}
}

func TestWSConnectorSendsAppLayerPings(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})
	c := quietConnector(t, conn, decoder, 10*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, nil
		})
	}()

	deadline := time.After(500 * time.Millisecond)
	for {
		writes := conn.snapshot()
		pings := 0
		for _, w := range writes {
			f, err := UnmarshalFrame(w)
			if err != nil {
				continue
			}
			if f.Method == FrameMethodControl && f.HeaderValue(FrameHeaderTypeKey) == FrameHeaderTypePing {
				pings++
			}
		}
		if pings >= 3 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected >=3 app-layer pings, got %d writes total", len(writes))
		case <-time.After(5 * time.Millisecond):
		}
	}

	cancel()
	<-done
}

func TestWSConnectorDecoderErrorAcksAndContinues(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	decodeCount := int32(0)
	decoder := FrameDecoderFunc(func(payload []byte, _ Installation) (InboundMessage, bool, error) {
		n := atomic.AddInt32(&decodeCount, 1)
		if n == 1 {
			return InboundMessage{}, false, errors.New("synthetic decode failure")
		}
		return InboundMessage{EventID: "good"}, true, nil
	})
	c := quietConnector(t, conn, decoder, time.Hour)

	emits := make(chan InboundMessage, 1)
	emit := func(_ context.Context, msg InboundMessage) (DispatchResult, error) {
		emits <- msg
		return DispatchResult{}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, emit)
	}()

	pushDataFrame(conn, []byte("bad"), "mb")
	pushDataFrame(conn, []byte("good"), "mg")

	select {
	case msg := <-emits:
		if msg.EventID != "good" {
			t.Errorf("emit EventID = %q, want good", msg.EventID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("connector exited after first decode error instead of dropping the frame")
	}

	cancel()
	<-done
}

// TestWSConnectorLogsDroppedEventTypeOncePerType covers #8496: an app can
// subscribe to event types we do not handle, and that path writes neither a
// log line nor a DB row, so the socket leaves no trace of what it receives.
// The type is named once per connection — a busy chat delivers reactions and
// membership churn continuously, and one line per frame would be unbounded.
// Heartbeats carry no event type and stay silent.
func TestWSConnectorLogsDroppedEventTypeOncePerType(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	logs := &syncBuffer{}
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})
	c := connectorWithLogger(t, conn, decoder, time.Hour, slog.New(slog.NewTextHandler(logs, nil)))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, nil
		})
	}()

	reaction := `{"schema":"2.0","header":{"event_type":"im.message.reaction.created_v1","event_id":"e%d"}}`
	pushDataFrame(conn, []byte(fmt.Sprintf(reaction, 1)), "m1")
	waitForWrites(t, conn, 1)
	if got := logs.String(); !strings.Contains(got, "im.message.reaction.created_v1") {
		t.Fatalf("dropped event type not logged; log was:\n%s", got)
	}

	// Same type again, plus a heartbeat: both ACKed, neither logged.
	pushDataFrame(conn, []byte(fmt.Sprintf(reaction, 2)), "m2")
	pushDataFrame(conn, []byte(`{}`), "m3")
	waitForWrites(t, conn, 3)
	if got := strings.Count(logs.String(), "dropping unhandled event type"); got != 1 {
		t.Errorf("log lines after a repeat + a heartbeat = %d, want 1; log was:\n%s", got, logs.String())
	}

	// A type we have not reported yet is worth one line of its own.
	pushDataFrame(conn, []byte(`{"schema":"2.0","header":{"event_type":"im.chat.access_event_v1","event_id":"e4"}}`), "m4")
	waitForWrites(t, conn, 4)
	if got := strings.Count(logs.String(), "dropping unhandled event type"); got != 2 {
		t.Errorf("log lines after a second event type = %d, want 2; log was:\n%s", got, logs.String())
	}

	cancel()
	<-done
}

// waitForWrites blocks until the connector has written n frames (each
// processed frame is ACKed), so a test can assert on what handling that
// frame did without racing the connector goroutine.
func waitForWrites(t *testing.T, conn *fakeWSConn, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(conn.snapshot()) >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("connector wrote %d frames, want %d", len(conn.snapshot()), n)
}

func TestWSConnectorReadErrorReturnsToHub(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})
	c := quietConnector(t, conn, decoder, time.Hour)

	ctx := context.Background()
	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, nil
		})
	}()

	// Close out from under the read loop. Because ctx is NOT cancelled,
	// the connector should treat this as a connection failure and
	// return the wrapped error so the Hub steps up its backoff.
	_ = conn.Close()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Run returned nil on read error; expected wrapped err for Hub backoff")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after underlying conn closed")
	}
}

func TestWSConnectorRequiresAllDeps(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		cfg  WSConnectorConfig
	}{
		{"no dialer", WSConnectorConfig{
			EndpointFetcher: EndpointFetcherFunc(func(context.Context, InstallationCredentials) (WSEndpoint, error) { return WSEndpoint{}, nil }),
			FrameDecoder:    FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) { return InboundMessage{}, false, nil }),
			CredentialsProvider: CredentialsProviderFunc(func(context.Context, Installation) (InstallationCredentials, error) {
				return InstallationCredentials{}, nil
			}),
		}},
		{"no endpoint fetcher", WSConnectorConfig{
			Dialer:       &fakeWSDialer{},
			FrameDecoder: FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) { return InboundMessage{}, false, nil }),
			CredentialsProvider: CredentialsProviderFunc(func(context.Context, Installation) (InstallationCredentials, error) {
				return InstallationCredentials{}, nil
			}),
		}},
		{"no decoder", WSConnectorConfig{
			Dialer:          &fakeWSDialer{},
			EndpointFetcher: EndpointFetcherFunc(func(context.Context, InstallationCredentials) (WSEndpoint, error) { return WSEndpoint{}, nil }),
			CredentialsProvider: CredentialsProviderFunc(func(context.Context, Installation) (InstallationCredentials, error) {
				return InstallationCredentials{}, nil
			}),
		}},
		{"no credentials provider", WSConnectorConfig{
			Dialer:          &fakeWSDialer{},
			EndpointFetcher: EndpointFetcherFunc(func(context.Context, InstallationCredentials) (WSEndpoint, error) { return WSEndpoint{}, nil }),
			FrameDecoder:    FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) { return InboundMessage{}, false, nil }),
		}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if _, err := NewWSLongConnConnector(tc.cfg); err == nil {
				t.Fatalf("expected error for missing dep")
			}
		})
	}
}

func TestWSConnectorDialErrorIsReturned(t *testing.T) {
	t.Parallel()
	dialErr := errors.New("dial blew up")
	c, err := NewWSLongConnConnector(WSConnectorConfig{
		Dialer: &fakeWSDialer{dialErr: dialErr},
		EndpointFetcher: EndpointFetcherFunc(func(context.Context, InstallationCredentials) (WSEndpoint, error) {
			return WSEndpoint{URL: "wss://x", ServiceID: 1}, nil
		}),
		FrameDecoder: FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) { return InboundMessage{}, false, nil }),
		CredentialsProvider: CredentialsProviderFunc(func(context.Context, Installation) (InstallationCredentials, error) {
			return InstallationCredentials{AppID: "a"}, nil
		}),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	err = c.Run(context.Background(), Installation{}, func(context.Context, InboundMessage) (DispatchResult, error) {
		return DispatchResult{}, nil
	})
	if err == nil || !errors.Is(err, dialErr) {
		t.Fatalf("expected wrapped dial error, got %v", err)
	}
}

// pushChunkedDataFrame pushes a Lark long-conn data Frame carrying one
// chunk of a multi-frame event. Lark splits big events across N frames
// with sum/seq/message_id headers; the connector reassembles before
// invoking the decoder.
func pushChunkedDataFrame(conn *fakeWSConn, payload []byte, messageID string, sum, seq int) {
	f := &Frame{
		Method:  FrameMethodData,
		Service: 7,
		Headers: []FrameHeader{
			{Key: FrameHeaderTypeKey, Value: FrameHeaderTypeEvent},
			{Key: FrameHeaderMessageIDKey, Value: messageID},
			{Key: FrameHeaderSumKey, Value: strconv.Itoa(sum)},
			{Key: FrameHeaderSeqKey, Value: strconv.Itoa(seq)},
		},
		Payload: payload,
	}
	conn.Push(f.Marshal())
}

// TestWSConnectorReassemblesChunkedDataFrame verifies that:
//   - intermediate chunks (sum>1, seq<sum-1) are NOT ACKed and NOT
//     emitted — the SDK's combine() contract;
//   - the final chunk completes the buffer, the decoder receives the
//     concatenated payload, and ONE ACK is written for the whole event.
//
// This is the regression test for the prior MVP behaviour where every
// data frame was decoded individually and chunked events were silently
// truncated then ACKed (server would never retry).
func TestWSConnectorReassemblesChunkedDataFrame(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	var decodedPayloads [][]byte
	var decodeMu sync.Mutex
	decoder := FrameDecoderFunc(func(payload []byte, _ Installation) (InboundMessage, bool, error) {
		decodeMu.Lock()
		decodedPayloads = append(decodedPayloads, append([]byte(nil), payload...))
		decodeMu.Unlock()
		return InboundMessage{EventID: string(payload)}, true, nil
	})
	c := quietConnector(t, conn, decoder, time.Hour) // disable ping cadence

	emits := make(chan InboundMessage, 4)
	emit := func(_ context.Context, msg InboundMessage) (DispatchResult, error) {
		emits <- msg
		return DispatchResult{Outcome: OutcomeIngested}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, emit)
	}()

	// Three chunks of a single logical event "ABC".
	pushChunkedDataFrame(conn, []byte("A"), "om-multi", 3, 0)
	pushChunkedDataFrame(conn, []byte("B"), "om-multi", 3, 1)
	pushChunkedDataFrame(conn, []byte("C"), "om-multi", 3, 2)

	select {
	case msg := <-emits:
		if msg.EventID != "ABC" {
			t.Errorf("emit EventID = %q; want ABC", msg.EventID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reassembled event did not reach emit in 2s")
	}

	// Drain the read loop briefly to let any pending ACK write land.
	time.Sleep(50 * time.Millisecond)

	// Exactly one ACK should have been written — only the final chunk
	// triggers ACK; intermediate chunks are silently buffered.
	cancel()
	<-done

	writes := conn.snapshot()
	dataAcks := 0
	for _, w := range writes {
		f, err := UnmarshalFrame(w)
		if err != nil {
			continue
		}
		if f.Method == FrameMethodData && bytes.Contains(f.Payload, []byte(`"code":200`)) {
			dataAcks++
		}
	}
	if dataAcks != 1 {
		t.Errorf("data-frame ACK count = %d; want exactly 1 (only the final chunk should ACK)", dataAcks)
	}

	decodeMu.Lock()
	defer decodeMu.Unlock()
	if len(decodedPayloads) != 1 {
		t.Fatalf("decoder invoked %d times; want exactly 1 (reassembled payload)", len(decodedPayloads))
	}
	if string(decodedPayloads[0]) != "ABC" {
		t.Errorf("decoder saw payload = %q; want ABC", string(decodedPayloads[0]))
	}
}

func TestGorillaDialerPreservesConfiguredDialerProxy(t *testing.T) {
	t.Parallel()

	proxyErr := errors.New("configured proxy refused")
	d := &GorillaDialer{
		Dialer: &websocket.Dialer{
			Proxy: func(*http.Request) (*url.URL, error) {
				return nil, proxyErr
			},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, _, err := d.DialContext(ctx, "ws://127.0.0.1:1", nil)
	if !errors.Is(err, proxyErr) {
		t.Fatalf("DialContext error = %v, want %v", err, proxyErr)
	}
}

func TestGorillaDialerProxyOverridesConfiguredDialerProxy(t *testing.T) {
	t.Parallel()

	configuredProxyErr := errors.New("configured proxy refused")
	overrideProxyErr := errors.New("override proxy refused")
	d := &GorillaDialer{
		Dialer: &websocket.Dialer{
			Proxy: func(*http.Request) (*url.URL, error) {
				return nil, configuredProxyErr
			},
		},
		Proxy: func(*http.Request) (*url.URL, error) {
			return nil, overrideProxyErr
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, _, err := d.DialContext(ctx, "ws://127.0.0.1:1", nil)
	if !errors.Is(err, overrideProxyErr) {
		t.Fatalf("DialContext error = %v, want %v", err, overrideProxyErr)
	}
	if errors.Is(err, configuredProxyErr) {
		t.Fatalf("DialContext used configured proxy error %v instead of override", configuredProxyErr)
	}
}

func TestGorillaDialerProxyForwardsError(t *testing.T) {
	t.Parallel()

	d := NewGorillaDialer()
	proxyErr := errors.New("proxy refused")
	d.Proxy = func(r *http.Request) (*url.URL, error) {
		return nil, proxyErr
	}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, _, err := d.DialContext(ctx, "ws://127.0.0.1:1", nil)
	if !errors.Is(err, proxyErr) {
		t.Fatalf("DialContext error = %v, want %v", err, proxyErr)
	}
}

func TestWSConnectorCredentialsErrorIsReturned(t *testing.T) {
	t.Parallel()
	credsErr := errors.New("decrypt failed")
	c, err := NewWSLongConnConnector(WSConnectorConfig{
		Dialer: &fakeWSDialer{conn: newFakeWSConn()},
		EndpointFetcher: EndpointFetcherFunc(func(context.Context, InstallationCredentials) (WSEndpoint, error) {
			return WSEndpoint{URL: "wss://x"}, nil
		}),
		FrameDecoder: FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) { return InboundMessage{}, false, nil }),
		CredentialsProvider: CredentialsProviderFunc(func(context.Context, Installation) (InstallationCredentials, error) {
			return InstallationCredentials{}, credsErr
		}),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	err = c.Run(context.Background(), Installation{}, func(context.Context, InboundMessage) (DispatchResult, error) {
		return DispatchResult{}, nil
	})
	if err == nil || !errors.Is(err, credsErr) {
		t.Fatalf("expected wrapped credentials error, got %v", err)
	}
}

func TestGorillaDialerInvalidProxyURL(t *testing.T) {
	t.Parallel()
	d := &GorillaDialer{
		Dialer:   websocket.DefaultDialer,
		ProxyURL: "://invalid-url",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, _, err := d.DialContext(ctx, "wss://example.com/ws", nil)
	if err == nil {
		t.Fatal("expected error for invalid proxy URL")
	}
	if !strings.Contains(err.Error(), "parse proxy url") {
		t.Fatalf("expected parse proxy url error, got: %v", err)
	}
}

func TestGorillaDialerProxyURLApplied(t *testing.T) {
	t.Parallel()
	// Use a valid proxy URL that points to a non-listening address.
	// The dial should fail with a connection error, not a parse error,
	// proving the proxy was configured.
	d := &GorillaDialer{
		Dialer:   websocket.DefaultDialer,
		ProxyURL: "http://127.0.0.1:1",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, _, err := d.DialContext(ctx, "wss://example.com/ws", nil)
	if err == nil {
		t.Fatal("expected connection error when proxy is unreachable")
	}
	if strings.Contains(err.Error(), "parse proxy url") {
		t.Fatalf("valid proxy URL should not produce parse error, got: %v", err)
	}
	// The error should be about the proxy connection (refused / timeout),
	// not about the URL parsing.
}

// cardConnector 构造带 CardHandler 的 connector。tweak 用来覆盖个别配置项，例如超时和 ping 间隔。
func cardConnector(t *testing.T, conn *fakeWSConn, decoder FrameDecoder, handler CardActionHandler, logger *slog.Logger, tweak ...func(*WSConnectorConfig)) *WSLongConnConnector {
	t.Helper()

	cfg := WSConnectorConfig{
		Dialer: &fakeWSDialer{conn: conn},
		EndpointFetcher: EndpointFetcherFunc(func(context.Context, InstallationCredentials) (WSEndpoint, error) {
			return WSEndpoint{URL: "wss://test/ignored", ServiceID: 7, PingInterval: time.Hour}, nil
		}),
		FrameDecoder: decoder,
		CredentialsProvider: CredentialsProviderFunc(func(context.Context, Installation) (InstallationCredentials, error) {
			return InstallationCredentials{AppID: "test_app", AppSecret: "secret"}, nil
		}),
		PingInterval: time.Hour,
		ReadDeadline: time.Second,
		WriteTimeout: time.Second,
		CardHandler:  handler,
		Logger:       logger,
	}
	for _, fn := range tweak {
		fn(&cfg)
	}

	c, err := NewWSLongConnConnector(cfg)
	if err != nil {
		t.Fatalf("NewWSLongConnConnector: %v", err)
	}

	return c
}

// runCardConnector 在后台跑 connector，返回取消函数；取消后等待 Run 退出。
func runCardConnector(t *testing.T, c *WSLongConnConnector) (stop func()) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, nil
		})
	}()

	return func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("Run did not return after cancel")
		}
	}
}

// cardTestMessageID 是测试里卡片帧的 message_id。
const cardTestMessageID = "mc1"

// pushCardFrame 下发一个 type=card 的数据帧，返回下发的帧，便于断言回写帧的 headers。
func pushCardFrame(conn *fakeWSConn, payload []byte) *Frame {
	return pushCallbackFrame(conn, FrameHeaderTypeCard, cardTestMessageID, payload)
}

// pushCallbackFrame 下发一个指定 type 和 message_id 的数据帧，返回下发的帧。
func pushCallbackFrame(conn *fakeWSConn, frameType, messageID string, payload []byte) *Frame {
	f := &Frame{
		Method:  FrameMethodData,
		Service: 7,
		Headers: []FrameHeader{
			{Key: FrameHeaderTypeKey, Value: frameType},
			{Key: FrameHeaderMessageIDKey, Value: messageID},
			{Key: "trace_id", Value: "trace-" + messageID},
		},
		Payload: payload,
	}
	conn.Push(f.Marshal())

	return f
}

// cardActionPayload 是 card.action.trigger 回调的最小载荷，tag 用来区分不同的点击。
func cardActionPayload(tag string) []byte {
	return []byte(`{"schema":"2.0","header":{"event_type":"card.action.trigger"},"event":{"action":{"value":{"tag":"` + tag + `"}}}}`)
}

// cardResponseMessageIDs 解出 connector 写出的每个帧的 message_id，按写出顺序排列。
func cardResponseMessageIDs(t *testing.T, conn *fakeWSConn) []string {
	t.Helper()

	var ids []string
	for i, raw := range conn.snapshot() {
		f, err := UnmarshalFrame(raw)
		if err != nil {
			t.Fatalf("write %d unmarshal: %v", i, err)
		}
		ids = append(ids, f.HeaderValue(FrameHeaderMessageIDKey))
	}

	return ids
}

// cardResponseEnvelope 是回写帧 payload 的 JSON 结构，Data 保留原始 JSON 以区分 null 与空串。
type cardResponseEnvelope struct {
	Code    int             `json:"code"`
	Headers json.RawMessage `json:"headers"`
	Data    json.RawMessage `json:"data"`
}

// readCardResponse 读取 connector 写出的第一个帧，解出 payload 外壳。
func readCardResponse(t *testing.T, conn *fakeWSConn) (*Frame, cardResponseEnvelope) {
	t.Helper()

	writes := conn.snapshot()
	if len(writes) == 0 {
		t.Fatal("connector wrote no frames")
	}

	f, err := UnmarshalFrame(writes[0])
	if err != nil {
		t.Fatalf("first write unmarshal: %v", err)
	}

	var env cardResponseEnvelope
	if err := json.Unmarshal(f.Payload, &env); err != nil {
		t.Fatalf("first write payload is not JSON: %v; payload=%s", err, f.Payload)
	}

	return f, env
}

func TestWSConnector_CardFrameCallsHandlerAndRespondsWithData(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()

	var decodeCalls atomic.Int32
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		decodeCalls.Add(1)
		return InboundMessage{}, false, nil
	})

	const toast = `{"toast":{"type":"success","content":"ok"}}`
	type handlerCall struct {
		payload     []byte
		hasDeadline bool
	}
	calls := make(chan handlerCall, 1)
	handler := func(ctx context.Context, payload []byte) ([]byte, error) {
		_, hasDeadline := ctx.Deadline()
		calls <- handlerCall{payload: append([]byte(nil), payload...), hasDeadline: hasDeadline}

		return []byte(toast), nil
	}

	stop := runCardConnector(t, cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer stop()

	const cardPayload = `{"schema":"2.0","header":{"event_type":"card.action.trigger"},"event":{"action":{"value":{"action":"join"}}}}`
	inbound := pushCardFrame(conn, []byte(cardPayload))

	waitForWrites(t, conn, 1)

	select {
	case call := <-calls:
		if string(call.payload) != cardPayload {
			t.Errorf("handler payload = %s; want %s", call.payload, cardPayload)
		}
		if !call.hasDeadline {
			t.Error("handler ctx has no deadline; want the card handler timeout")
		}
	default:
		t.Fatal("handler was not called")
	}

	resp, env := readCardResponse(t, conn)
	if resp.Method != inbound.Method || resp.Service != inbound.Service {
		t.Errorf("response method/service = %d/%d; want %d/%d", resp.Method, resp.Service, inbound.Method, inbound.Service)
	}
	if len(resp.Headers) != len(inbound.Headers) {
		t.Fatalf("response headers = %+v; want %+v", resp.Headers, inbound.Headers)
	}
	for i, h := range inbound.Headers {
		if resp.Headers[i] != h {
			t.Errorf("response header[%d] = %+v; want %+v", i, resp.Headers[i], h)
		}
	}

	if env.Code != 200 {
		t.Errorf("code = %d; want 200", env.Code)
	}
	if string(env.Headers) != "null" {
		t.Errorf("headers = %s; want null", env.Headers)
	}

	var data []byte
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("data is not a base64 string: %v; data=%s", err, env.Data)
	}
	if string(data) != toast {
		t.Errorf("decoded data = %s; want %s", data, toast)
	}

	if got := decodeCalls.Load(); got != 0 {
		t.Errorf("event decoder called %d times for a card frame; want 0", got)
	}
}

func TestWSConnector_CardFrameHandlerErrorStillAcks(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	logs := &syncBuffer{}

	var decodeCalls atomic.Int32
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		decodeCalls.Add(1)
		return InboundMessage{}, false, nil
	})
	handler := func(context.Context, []byte) ([]byte, error) {
		return []byte(`{"toast":{"type":"error","content":"ignored"}}`), errors.New("handler blew up")
	}

	stop := runCardConnector(t, cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(logs, nil))))
	defer stop()

	pushCardFrame(conn, []byte(`{"event":{}}`))
	waitForWrites(t, conn, 1)

	_, env := readCardResponse(t, conn)
	if env.Code != 200 {
		t.Errorf("code = %d; want 200", env.Code)
	}
	if string(env.Data) != "null" {
		t.Errorf("data = %s; want null", env.Data)
	}
	if got := logs.String(); !strings.Contains(got, "card handler failed") || !strings.Contains(got, "handler blew up") {
		t.Errorf("handler error not logged; log was:\n%s", got)
	}

	// 连接没有因为 handler 出错而断开：后续的事件帧照常被 ACK。
	pushDataFrame(conn, []byte(`{}`), "m2")
	waitForWrites(t, conn, 2)

	if got := decodeCalls.Load(); got != 1 {
		t.Errorf("event decoder calls = %d; want 1 (only the event frame)", got)
	}
}

func TestWSConnector_CardFrameHandlerPanicStillAcks(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	logs := &syncBuffer{}

	var decodeCalls atomic.Int32
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		decodeCalls.Add(1)
		return InboundMessage{}, false, nil
	})
	handler := func(context.Context, []byte) ([]byte, error) {
		panic("handler blew up")
	}

	done := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(logs, nil)))
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, nil
		})
	}()

	pushCardFrame(conn, []byte(`{"event":{}}`))
	waitForWrites(t, conn, 1)

	_, env := readCardResponse(t, conn)
	if env.Code != 200 {
		t.Errorf("code = %d; want 200", env.Code)
	}
	if string(env.Data) != "null" {
		t.Errorf("data = %s; want null", env.Data)
	}

	got := logs.String()
	if !strings.Contains(got, "card handler panicked") || !strings.Contains(got, "handler blew up") {
		t.Errorf("panic not logged; log was:\n%s", got)
	}
	if !strings.Contains(got, "TestWSConnector_CardFrameHandlerPanicStillAcks") {
		t.Errorf("panic log has no stack pointing at the handler; log was:\n%s", got)
	}

	// 连接没有因为 handler panic 而退出：Run 仍在运行，后续的事件帧照常被 ACK。
	select {
	case err := <-done:
		t.Fatalf("Run returned after a handler panic: %v", err)
	default:
	}

	pushDataFrame(conn, []byte(`{}`), "m2")
	waitForWrites(t, conn, 2)

	if got := decodeCalls.Load(); got != 1 {
		t.Errorf("event decoder calls = %d; want 1 (only the event frame)", got)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}

func TestWSConnector_CardFrameWithoutHandlerAcks(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()

	var decodeCalls atomic.Int32
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		decodeCalls.Add(1)
		return InboundMessage{}, false, nil
	})

	stop := runCardConnector(t, cardConnector(t, conn, decoder, nil, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer stop()

	pushCardFrame(conn, []byte(`{"event":{}}`))
	waitForWrites(t, conn, 1)

	_, env := readCardResponse(t, conn)
	if env.Code != 200 {
		t.Errorf("code = %d; want 200", env.Code)
	}
	if string(env.Data) != "null" {
		t.Errorf("data = %s; want null", env.Data)
	}

	// 没有 handler 时卡片帧走原有逻辑，交给事件解码器后 ACK。
	if got := decodeCalls.Load(); got != 1 {
		t.Errorf("event decoder calls = %d; want 1", got)
	}
}

func TestWSConnector_CardFrameHandlerTimeoutStillAcks(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()

	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})
	// handler 一直阻塞到 ctx 超时，模拟下游迟迟不返回。
	ctxErrs := make(chan error, 1)
	handler := func(ctx context.Context, _ []byte) ([]byte, error) {
		<-ctx.Done()
		ctxErrs <- ctx.Err()

		return nil, ctx.Err()
	}

	c := cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(io.Discard, nil)), func(cfg *WSConnectorConfig) {
		cfg.CardHandlerTimeout = 20 * time.Millisecond
	})
	stop := runCardConnector(t, c)
	defer stop()

	pushCardFrame(conn, []byte(`{"event":{}}`))
	waitForWrites(t, conn, 1)

	select {
	case err := <-ctxErrs:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("handler ctx ended with %v; want deadline exceeded", err)
		}
	default:
		t.Fatal("handler was not called")
	}

	_, env := readCardResponse(t, conn)
	if env.Code != 200 {
		t.Errorf("code = %d; want 200", env.Code)
	}
	if string(env.Data) != "null" {
		t.Errorf("data = %s; want null", env.Data)
	}
}

// TestWSConnector_CardFrameHandlerDoesNotBlockPing 确认 handler 运行期间不占着写锁：
// handler 等到后台 ping 写出后才返回；若写锁被占住，ping 写不出去，handler 会一直等到超时。
func TestWSConnector_CardFrameHandlerDoesNotBlockPing(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()

	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})

	sawPing := make(chan bool, 1)
	handler := func(ctx context.Context, _ []byte) ([]byte, error) {
		for {
			if len(conn.snapshot()) > 0 {
				sawPing <- true

				return nil, nil
			}

			select {
			case <-ctx.Done():
				sawPing <- false

				return nil, ctx.Err()
			case <-time.After(5 * time.Millisecond):
			}
		}
	}

	c := cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(io.Discard, nil)), func(cfg *WSConnectorConfig) {
		cfg.CardHandlerTimeout = time.Second
		cfg.PingInterval = 10 * time.Millisecond
		cfg.EndpointFetcher = EndpointFetcherFunc(func(context.Context, InstallationCredentials) (WSEndpoint, error) {
			return WSEndpoint{URL: "wss://test/ignored", ServiceID: 7, PingInterval: 10 * time.Millisecond}, nil
		})
	})
	stop := runCardConnector(t, c)
	defer stop()

	pushCardFrame(conn, []byte(`{"event":{}}`))

	select {
	case ok := <-sawPing:
		if !ok {
			t.Fatal("no ping was written while the card handler was running; writeMu is held across the handler")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("card handler did not finish")
	}
}

// TestWSConnector_EventFrameCardActionCallsHandler 覆盖官方 SDK 的推送形式：卡片回调走 type=event 帧，
// 载荷 header.event_type 为 card.action.trigger。这种帧交给 CardHandler，回应随回写帧带回，不进事件解码器。
func TestWSConnector_EventFrameCardActionCallsHandler(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()

	var decodeCalls atomic.Int32
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		decodeCalls.Add(1)
		return InboundMessage{}, false, nil
	})

	const toast = `{"toast":{"type":"success","content":"ok"}}`
	calls := make(chan []byte, 1)
	handler := func(_ context.Context, payload []byte) ([]byte, error) {
		calls <- append([]byte(nil), payload...)

		return []byte(toast), nil
	}

	stop := runCardConnector(t, cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer stop()

	payload := cardActionPayload("event-frame")
	inbound := pushCallbackFrame(conn, FrameHeaderTypeEvent, "me1", payload)
	waitForWrites(t, conn, 1)

	select {
	case got := <-calls:
		if string(got) != string(payload) {
			t.Errorf("handler payload = %s; want %s", got, payload)
		}
	default:
		t.Fatal("handler was not called for an event frame carrying card.action.trigger")
	}

	resp, env := readCardResponse(t, conn)
	if len(resp.Headers) != len(inbound.Headers) || resp.HeaderValue(FrameHeaderMessageIDKey) != "me1" {
		t.Fatalf("response headers = %+v; want the inbound headers %+v", resp.Headers, inbound.Headers)
	}

	var data []byte
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("data is not a base64 string: %v; data=%s", err, env.Data)
	}
	if string(data) != toast {
		t.Errorf("decoded data = %s; want %s", data, toast)
	}

	if got := decodeCalls.Load(); got != 0 {
		t.Errorf("event decoder called %d times for a card action; want 0", got)
	}
}

// TestWSConnector_EventFrameOtherTypeSkipsCardHandler 确认配了 CardHandler 时，其他事件类型的 event 帧仍走事件解码器。
func TestWSConnector_EventFrameOtherTypeSkipsCardHandler(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()

	var decodeCalls atomic.Int32
	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		decodeCalls.Add(1)
		return InboundMessage{}, false, nil
	})

	var handlerCalls atomic.Int32
	handler := func(context.Context, []byte) ([]byte, error) {
		handlerCalls.Add(1)
		return nil, nil
	}

	stop := runCardConnector(t, cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer stop()

	pushCallbackFrame(conn, FrameHeaderTypeEvent, "me2", []byte(`{"schema":"2.0","header":{"event_type":"im.message.receive_v1"},"event":{}}`))
	waitForWrites(t, conn, 1)

	if got := handlerCalls.Load(); got != 0 {
		t.Errorf("card handler called %d times for a message event; want 0", got)
	}
	if got := decodeCalls.Load(); got != 1 {
		t.Errorf("event decoder calls = %d; want 1", got)
	}
}

// TestWSConnector_SlowCardHandlerDoesNotBlockNextCard 确认卡片回调不在读循环里串行处理：
// 第一次点击的处理器一直不返回，第二次点击照样先拿到回应。
func TestWSConnector_SlowCardHandlerDoesNotBlockNextCard(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()

	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})

	release := make(chan struct{})
	handler := func(ctx context.Context, payload []byte) ([]byte, error) {
		if strings.Contains(string(payload), `"slow"`) {
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		return []byte(`{"toast":{"type":"info","content":"ok"}}`), nil
	}

	c := cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(io.Discard, nil)), func(cfg *WSConnectorConfig) {
		cfg.CardHandlerTimeout = 5 * time.Second
	})
	stop := runCardConnector(t, c)
	defer stop()

	pushCallbackFrame(conn, FrameHeaderTypeCard, "slow", cardActionPayload("slow"))
	pushCallbackFrame(conn, FrameHeaderTypeEvent, "fast", cardActionPayload("fast"))

	waitForWrites(t, conn, 1)
	if ids := cardResponseMessageIDs(t, conn); ids[0] != "fast" {
		t.Fatalf("first response message_id = %q; want the fast click answered while the slow one is still running (writes %v)", ids[0], ids)
	}

	close(release)
	waitForWrites(t, conn, 2)
	if ids := cardResponseMessageIDs(t, conn); ids[1] != "slow" {
		t.Fatalf("second response message_id = %q; want slow (writes %v)", ids[1], ids)
	}
}

// TestWSConnector_RunWaitsForInFlightCardHandlers 确认连接退出前等正在处理的卡片回调结束，不留下后台 goroutine。
func TestWSConnector_RunWaitsForInFlightCardHandlers(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()

	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})

	started := make(chan struct{})
	release := make(chan struct{})
	var finished atomic.Bool
	handler := func(context.Context, []byte) ([]byte, error) {
		close(started)
		<-release
		finished.Store(true)

		return nil, nil
	}

	c := cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- c.Run(ctx, Installation{AppID: "test_app"}, func(context.Context, InboundMessage) (DispatchResult, error) {
			return DispatchResult{}, nil
		})
	}()

	pushCardFrame(conn, cardActionPayload("in-flight"))
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("card handler did not start")
	}

	cancel()
	select {
	case err := <-done:
		t.Fatalf("Run returned (%v) while a card handler was still running", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after the card handler finished")
	}
	if !finished.Load() {
		t.Fatal("Run returned before the card handler finished")
	}
}

// TestWSConnector_CardHandlerPoolFullAnswersWithinTimeout 确认池满时超时从收到帧时开始计：
// 处理器全被占住，新来的回调等不到空位，到时限就回空回应，不等前面的回调结束。
func TestWSConnector_CardHandlerPoolFullAnswersWithinTimeout(t *testing.T) {
	t.Parallel()
	conn := newFakeWSConn()
	logs := &syncBuffer{}

	decoder := FrameDecoderFunc(func([]byte, Installation) (InboundMessage, bool, error) {
		return InboundMessage{}, false, nil
	})

	release := make(chan struct{})
	var running atomic.Int32
	handler := func(context.Context, []byte) ([]byte, error) {
		running.Add(1)
		<-release

		return nil, nil
	}

	c := cardConnector(t, conn, decoder, handler, slog.New(slog.NewTextHandler(logs, nil)), func(cfg *WSConnectorConfig) {
		cfg.CardHandlerTimeout = 100 * time.Millisecond
	})
	stop := runCardConnector(t, c)
	defer stop()

	for i := range cardHandlerConcurrency {
		pushCallbackFrame(conn, FrameHeaderTypeCard, fmt.Sprintf("busy-%d", i), cardActionPayload("busy"))
	}
	pushCallbackFrame(conn, FrameHeaderTypeCard, "overflow", cardActionPayload("overflow"))

	waitForWrites(t, conn, 1)
	if ids := cardResponseMessageIDs(t, conn); ids[0] != "overflow" {
		t.Fatalf("first response message_id = %q; want the overflow click answered at its deadline (writes %v)", ids[0], ids)
	}
	_, env := readCardResponse(t, conn)
	if string(env.Data) != "null" {
		t.Errorf("overflow data = %s; want null", env.Data)
	}
	if got := running.Load(); got != cardHandlerConcurrency {
		t.Errorf("running handlers = %d; want %d", got, cardHandlerConcurrency)
	}
	if got := logs.String(); !strings.Contains(got, "card handler pool exhausted") {
		t.Errorf("pool exhaustion not logged; log was:\n%s", got)
	}

	close(release)
	waitForWrites(t, conn, cardHandlerConcurrency+1)
}
