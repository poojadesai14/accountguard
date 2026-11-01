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
	scrape := func() string {
		t.Helper()
		w := f.get("/metrics")
		requireStatus(t, w, http.StatusOK)
		return w.Body.String()
	}

	requireStatus(t, request(t, f.handler, "GET", "/metrics", "", nil), http.StatusUnauthorized)
	requireStatus(t, request(t, f.handler, "GET", "/metrics", testIngestToken, nil), http.StatusUnauthorized)

	ev := f.email(testNow, 16509, "stripe.com")
	f.ingest(ev, "allow")
	f.ingest(ev, "allow") // a duplicate returns the stored decision and isn't counted again
	f.ingest(f.email(testNow.Add(time.Minute), 14061, "stripe.com"), "allow")

	body := scrape()
	for _, want := range []string{
		`ato_decisions_total{action="allow",enforced="true"} 2`,
		`ato_scoring_latency_seconds_count 2`,
		`ato_unscored_total 0`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics missing %q", want)
		}
	}

	// A scoring timeout fails open and is counted.
	tx, err := f.server.Store.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(context.Background(), `lock table events in access exclusive mode`); err != nil {
		t.Fatal(err)
	}
	f.server.Config.Scoring.TimeoutMS = 30
	d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, f.email(testNow.Add(2*time.Minute), 16509, "stripe.com")))
	if !d.Unscored {
		t.Fatalf("response = %+v, want unscored", d)
	}
	if err := tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if body := scrape(); !strings.Contains(body, "ato_unscored_total 1") {
		t.Error("unscored event was not counted")
	}
}
