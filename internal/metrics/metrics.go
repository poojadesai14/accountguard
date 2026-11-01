// Package metrics holds the service's Prometheus collectors (SPEC §13).
// Labels are bounded: actions, signal names and a boolean. Never account or key ids.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry       *prometheus.Registry
	decisions      *prometheus.CounterVec
	signalHits     *prometheus.CounterVec
	scoringLatency prometheus.Histogram
	unscored       prometheus.Counter
	holdsPending   prometheus.Gauge
}

// New uses its own registry, so tests can create as many as they like.
func New() *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		decisions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ato_decisions_total", Help: "Scored events by action and whether the action was enforced.",
		}, []string{"action", "enforced"}),
		signalHits: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ato_signal_hits_total", Help: "Signals that fired, by signal name.",
		}, []string{"name"}),
		// The scoring deadline is 200 ms; buckets resolve the normal 10-30 ms range and the tail near it.
		scoringLatency: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "ato_scoring_latency_seconds", Help: "Time to score an event, including the database transaction.",
			Buckets: []float64{.005, .01, .02, .03, .05, .075, .1, .15, .2, .3, .5},
		}),
		unscored: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ato_unscored_total", Help: "Events allowed without a score because scoring failed or missed the deadline.",
		}),
		holdsPending: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ato_holds_pending", Help: "Held emails waiting for an owner or analyst, updated by the hold ticker.",
		}),
	}
	m.registry.MustRegister(m.decisions, m.signalHits, m.scoringLatency, m.unscored, m.holdsPending,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}

// The methods are nil-safe so the engine and tests can run without metrics.

func (m *Metrics) Decision(action string, enforced bool, hits []string, latency time.Duration) {
	if m == nil {
		return
	}
	m.decisions.WithLabelValues(action, strconv.FormatBool(enforced)).Inc()
	for _, name := range hits {
		m.signalHits.WithLabelValues(name).Inc()
	}
	m.scoringLatency.Observe(latency.Seconds())
}

func (m *Metrics) Unscored() {
	if m != nil {
		m.unscored.Inc()
	}
}

func (m *Metrics) HoldsPending(n int) {
	if m != nil {
		m.holdsPending.Set(float64(n))
	}
}

func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}
