package metrics

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/yunboom/marvis/server/internal/daemonws"
)

func TestDaemonWSCollectorSeparatesRuntimeGoneDelivery(t *testing.T) {
	m := &daemonws.Metrics{}
	m.WakeupDeliveredHit.Store(3)
	m.WakeupDeliveredMiss.Store(4)
	m.RuntimeGoneDeliveredHit.Store(5)
	m.RuntimeGoneDeliveredMiss.Store(6)
	m.RuntimeGonePublishedTotal.Store(7)
	m.RuntimeGonePublishErrors.Store(8)
	m.RuntimeGoneReceivedTotal.Store(9)

	err := testutil.CollectAndCompare(NewDaemonWSCollector(m), strings.NewReader(`
# HELP marvis_daemonws_runtime_gone_delivered_total Total runtime-gone local delivery attempts.
# TYPE marvis_daemonws_runtime_gone_delivered_total counter
marvis_daemonws_runtime_gone_delivered_total{result="hit"} 5
marvis_daemonws_runtime_gone_delivered_total{result="miss"} 6
# HELP marvis_daemonws_runtime_gone_publish_errors_total Total runtime-gone Redis publish errors.
# TYPE marvis_daemonws_runtime_gone_publish_errors_total counter
marvis_daemonws_runtime_gone_publish_errors_total 8
# HELP marvis_daemonws_runtime_gone_published_total Total runtime-gone notifications published to the Redis relay.
# TYPE marvis_daemonws_runtime_gone_published_total counter
marvis_daemonws_runtime_gone_published_total 7
# HELP marvis_daemonws_runtime_gone_received_total Total runtime-gone notifications received from the Redis relay.
# TYPE marvis_daemonws_runtime_gone_received_total counter
marvis_daemonws_runtime_gone_received_total 9
# HELP marvis_daemonws_wakeup_delivered_total Total daemon wakeup local delivery attempts.
# TYPE marvis_daemonws_wakeup_delivered_total counter
marvis_daemonws_wakeup_delivered_total{result="hit"} 3
marvis_daemonws_wakeup_delivered_total{result="miss"} 4
`),
		"marvis_daemonws_runtime_gone_delivered_total",
		"marvis_daemonws_runtime_gone_publish_errors_total",
		"marvis_daemonws_runtime_gone_published_total",
		"marvis_daemonws_runtime_gone_received_total",
		"marvis_daemonws_wakeup_delivered_total",
	)
	if err != nil {
		t.Fatalf("collect daemon websocket delivery metrics: %v", err)
	}
}
