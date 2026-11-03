package api

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestMetrics(t *testing.T) {
	f := newAPIFixture(t)
	scrape := func(t *testing.T) string {
		t.Helper()
		w := f.get("/metrics")
		requireStatus(t, w, http.StatusOK)
		return w.Body.String()
	}

	// Steps run in order on one fixture: each builds on the counters before it.
	steps := []struct {
		name string
		run  func(t *testing.T)
		want []string // lines the next scrape must contain
	}{
		{
			name: "only the analyst token may scrape",
			run: func(t *testing.T) {
				for _, token := range []string{"", testIngestToken} {
					requireStatus(t, request(t, f.handler, "GET", "/metrics", token, nil), http.StatusUnauthorized)
				}
			},
		},
		{
			name: "decisions are counted once; a duplicate event is not",
			run: func(t *testing.T) {
				ev := f.email(testNow, 16509, "stripe.com")
				f.ingest(ev, "allow")
				f.ingest(ev, "allow")
				f.ingest(f.email(testNow.Add(time.Minute), 14061, "stripe.com"), "allow")
			},
			want: []string{
				`ato_decisions_total{action="allow",enforced="true"} 2`,
				`ato_scoring_latency_seconds_count 2`,
				`ato_unscored_total{reason="timeout"} 0`,
			},
		},
		{
			name: "a scoring timeout fails open and is counted",
			run: func(t *testing.T) {
				ctx := context.Background()
				tx, err := f.server.Store.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				if _, err := tx.Exec(ctx, `lock table events in access exclusive mode`); err != nil {
					t.Fatal(err)
				}
				f.server.Config.Scoring.TimeoutMS = 30
				d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, f.email(testNow.Add(2*time.Minute), 16509, "stripe.com")))
				if !d.Unscored {
					t.Fatalf("response = %+v, want unscored", d)
				}
			},
			want: []string{`ato_unscored_total{reason="timeout"} 1`, `ato_unscored_total{reason="error"} 0`},
		},
		{
			name: "an analyst suspension is counted",
			run: func(t *testing.T) {
				w := f.post("/v1/keys/key/suspend", map[string]string{"actor": "reviewer", "reason": "phishing"})
				requireStatus(t, w, http.StatusOK)
			},
			want: []string{`ato_key_suspensions_total{reason="analyst"} 1`},
		},
	}
	for _, step := range steps {
		if !t.Run(step.name, func(t *testing.T) {
			step.run(t)
			if len(step.want) == 0 {
				return
			}
			body := scrape(t)
			for _, line := range step.want {
				if !strings.Contains(body, line) {
					t.Errorf("metrics missing %q", line)
				}
			}
		}) {
			t.FailNow() // later steps depend on this one
		}
	}
}
