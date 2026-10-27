package landiscovery

import (
	"context"
	"errors"
	"net"
	"reflect"
	"testing"
	"time"
)

// fakeAdvert 记录是否被撤销。
type fakeAdvert struct {
	stopped bool
	host    string
}

func (f *fakeAdvert) Stop() {
	f.stopped = true
}

func (f *fakeAdvert) Hostname() string {
	return f.host
}

// loopHarness 让测试逐步给出网卡扫描结果，并记录每次启动的广播。
type loopHarness struct {
	scans   [][]lanIface
	scanErr error
	starts  [][]lanIface
	adverts []*fakeAdvert
	failing bool
	// hosts 是每次启动依次选中的主机名，用完后沿用最后一个；为空时用 marvis.local。
	hosts []string
	// status 记录广播当前使用的主机名，为 nil 时不记录。
	status *Status
}

func (h *loopHarness) loop() *advertLoop {
	return &advertLoop{
		scan: func() ([]lanIface, error) {
			if h.scanErr != nil {
				return nil, h.scanErr
			}

			next := h.scans[0]
			if len(h.scans) > 1 {
				h.scans = h.scans[1:]
			}

			return next, nil
		},
		start: func(_ context.Context, ifaces []lanIface) (advertisement, error) {
			h.starts = append(h.starts, ifaces)
			if h.failing {
				return nil, errors.New("listen mdns port=5353: address in use")
			}

			advert := &fakeAdvert{host: h.nextHost()}
			h.adverts = append(h.adverts, advert)

			return advert, nil
		},
		status: h.status,
	}
}

// nextHost 返回本次启动选中的主机名。
func (h *loopHarness) nextHost() string {
	if len(h.hosts) == 0 {
		return DefaultHostname + hostSuffix
	}

	next := h.hosts[0]
	if len(h.hosts) > 1 {
		h.hosts = h.hosts[1:]
	}

	return next
}

func lan(name string, index int, ips ...string) lanIface {
	li := lanIface{iface: net.Interface{Index: index, Name: name}}
	for _, ip := range ips {
		li.ips = append(li.ips, net.ParseIP(ip).To4())
	}

	return li
}

func TestAdvertLoopRetriesUntilAnAddressAppears(t *testing.T) {
	h := &loopHarness{scans: [][]lanIface{nil, nil, {lan("en0", 2, "192.168.1.20")}}}
	loop := h.loop()

	loop.reconcile(context.Background())
	loop.reconcile(context.Background())
	if len(h.starts) != 0 {
		t.Fatalf("started %d times without a LAN address, want 0", len(h.starts))
	}

	loop.reconcile(context.Background())
	if len(h.starts) != 1 {
		t.Fatalf("started %d times after an address appeared, want 1", len(h.starts))
	}
}

func TestAdvertLoopKeepsAdvertisingWhileAddressesAreUnchanged(t *testing.T) {
	h := &loopHarness{scans: [][]lanIface{{lan("en0", 2, "192.168.1.20")}}}
	loop := h.loop()

	for range 3 {
		loop.reconcile(context.Background())
	}

	if len(h.starts) != 1 || h.adverts[0].stopped {
		t.Fatalf("starts = %d, first stopped = %v, want one running advertisement", len(h.starts), h.adverts[0].stopped)
	}
}

func TestAdvertLoopReadvertisesWhenAddressesChange(t *testing.T) {
	h := &loopHarness{scans: [][]lanIface{
		{lan("en0", 2, "192.168.1.20")},
		{lan("en0", 2, "192.168.1.31")},
	}}
	loop := h.loop()

	loop.reconcile(context.Background())
	loop.reconcile(context.Background())

	if len(h.starts) != 2 {
		t.Fatalf("starts = %d, want 2", len(h.starts))
	}
	if !h.adverts[0].stopped || h.adverts[1].stopped {
		t.Fatalf("old stopped = %v, new stopped = %v, want the old one withdrawn and the new one running", h.adverts[0].stopped, h.adverts[1].stopped)
	}
	if got := lanIfaceSummary(h.starts[1]); !reflect.DeepEqual(got, map[string][]string{"en0": {"192.168.1.31"}}) {
		t.Fatalf("second start = %v, want the new address", got)
	}
}

func TestAdvertLoopWithdrawsWhenAddressesDisappear(t *testing.T) {
	h := &loopHarness{scans: [][]lanIface{{lan("en0", 2, "192.168.1.20")}, nil}}
	loop := h.loop()

	loop.reconcile(context.Background())
	loop.reconcile(context.Background())

	if !h.adverts[0].stopped || len(h.starts) != 1 {
		t.Fatalf("stopped = %v, starts = %d, want the advertisement withdrawn and no new start", h.adverts[0].stopped, len(h.starts))
	}
}

func TestAdvertLoopRetriesAfterStartFailure(t *testing.T) {
	h := &loopHarness{scans: [][]lanIface{{lan("en0", 2, "192.168.1.20")}}, failing: true}
	loop := h.loop()

	loop.reconcile(context.Background())
	h.failing = false
	loop.reconcile(context.Background())

	if len(h.starts) != 2 || len(h.adverts) != 1 {
		t.Fatalf("starts = %d, adverts = %d, want a retry that succeeds", len(h.starts), len(h.adverts))
	}
}

func TestAdvertLoopKeepsAdvertisingWhenScanFails(t *testing.T) {
	h := &loopHarness{scans: [][]lanIface{{lan("en0", 2, "192.168.1.20")}}}
	loop := h.loop()

	loop.reconcile(context.Background())
	h.scanErr = errors.New("route ip+net: no such network interface")
	loop.reconcile(context.Background())

	if h.adverts[0].stopped {
		t.Fatal("a failed interface scan withdrew the running advertisement")
	}
}

func TestAdvertLoopRunStopsOnCancel(t *testing.T) {
	h := &loopHarness{scans: [][]lanIface{{lan("en0", 2, "192.168.1.20")}}}
	loop := h.loop()

	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time)
	done := make(chan struct{})

	go func() {
		defer close(done)
		loop.run(ctx, ticks)
	}()

	// 每次 tick 都要等上一轮检查结束才会被接收，第二次发送成功说明首轮已启动广播。
	ticks <- time.Time{}
	ticks <- time.Time{}
	cancel()
	<-done

	if len(h.adverts) != 1 || !h.adverts[0].stopped {
		t.Fatalf("adverts = %d, stopped = %v, want the advertisement withdrawn on cancel", len(h.adverts), len(h.adverts) == 1 && h.adverts[0].stopped)
	}
}

func TestAdvertLoopPublishesTheAdvertisedHostname(t *testing.T) {
	status := &Status{}
	h := &loopHarness{
		scans: [][]lanIface{
			{lan("en0", 2, "192.168.1.20")},
			nil,
			{lan("en0", 2, "192.168.1.31")},
		},
		hosts:  []string{"marvis.local", "marvis-2.local"},
		status: status,
	}
	loop := h.loop()

	if got := status.Hostname(); got != "" {
		t.Fatalf("hostname before advertising = %q, want empty", got)
	}

	loop.reconcile(context.Background())
	if got := status.Hostname(); got != "marvis.local" {
		t.Fatalf("hostname while advertising = %q, want marvis.local", got)
	}

	loop.reconcile(context.Background())
	if got := status.Hostname(); got != "" {
		t.Fatalf("hostname after the address disappeared = %q, want empty", got)
	}

	loop.reconcile(context.Background())
	if got := status.Hostname(); got != "marvis-2.local" {
		t.Fatalf("hostname after re-advertising = %q, want marvis-2.local", got)
	}
}

func TestStatusHostnameOnNilStatus(t *testing.T) {
	var status *Status
	if got := status.Hostname(); got != "" {
		t.Fatalf("nil status hostname = %q, want empty", got)
	}
}

func TestAddressKeyIgnoresInterfaceOrder(t *testing.T) {
	a := addressKey([]lanIface{lan("en0", 2, "192.168.1.20"), lan("en1", 3, "10.0.0.5")})
	b := addressKey([]lanIface{lan("en1", 3, "10.0.0.5"), lan("en0", 2, "192.168.1.20")})
	if a != b {
		t.Fatalf("addressKey differs by order: %q vs %q", a, b)
	}

	if c := addressKey([]lanIface{lan("en0", 2, "192.168.1.21"), lan("en1", 3, "10.0.0.5")}); c == a {
		t.Fatalf("addressKey did not change with the address: %q", c)
	}
}

func TestRunRejectsInvalidPort(t *testing.T) {
	for _, port := range []int{0, -1, 70000} {
		if err := Run(context.Background(), Config{Enabled: true, Name: "studio", Port: port}, "", "7f3a", &Status{}); err == nil {
			t.Fatalf("Run(port=%d) error = nil, want an error", port)
		}
	}
}
