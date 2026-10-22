package metrics

import "testing"

func TestRegistryExcludesDatabaseSampledMetrics(t *testing.T) {
	registry := NewRegistry(RegistryOptions{})
	families, err := registry.Gatherer.Gather()
	if err != nil {
		t.Fatalf("gather metrics: %v", err)
	}

	retired := map[string]struct{}{
		"marvis_agent_task_queued":                               {},
		"marvis_agent_task_running":                              {},
		"marvis_agent_task_stuck_total":                          {},
		"marvis_business_sampler_query_errors_total":             {},
		"marvis_business_sampler_query_seconds":                  {},
		"marvis_workspace_total":                                 {},
		"marvis_seat_capacity_outbox_pending":                    {},
		"marvis_seat_capacity_outbox_dead_lettered":              {},
		"marvis_seat_capacity_outbox_oldest_pending_age_seconds": {},
		"marvis_channel_media_pending_objects":                   {},
		"marvis_channel_media_tombstoned_objects":                {},
		"marvis_runtime_gc_blocked_observation_failed_total":     {},
		"marvis_runtime_gc_blocked_runtimes":                     {},
		"marvis_runtime_gc_backlog_runtimes":                     {},
	}
	for _, family := range families {
		if _, found := retired[family.GetName()]; found {
			t.Errorf("retired database-sampled metric %q is still registered", family.GetName())
		}
	}
}
