package api

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/engine"
	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/profile"
	"github.com/poojadesai14/resend-ato/internal/store"
	"github.com/poojadesai14/resend-ato/migrations"
)

var testNow = time.Date(2026, 10, 30, 14, 0, 0, 0, time.UTC)

type apiFixture struct {
	t       *testing.T
	server  *Server
	handler http.Handler
	n       int
}

// Every fixture has its own schema, including aggregate queries. Never truncate a
// shared database: these tests can run beside engine tests or seeded demo data.
func newAPIFixture(t *testing.T) *apiFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := store.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("api_test_%x", rand.Uint64())}.Sanitize()
	if _, err := admin.Pool.Exec(ctx, "create schema "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		defer admin.Close()
		if _, err := admin.Pool.Exec(context.Background(), "drop schema "+schema+" cascade"); err != nil {
			t.Error(err)
		}
	})
	u, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	db, err := store.Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err := store.Migrate(ctx, db.Pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load("../../config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	// Functional integration tests must tolerate race instrumentation and shared
	// CI scheduling. The timeout test below explicitly sets its own short limit.
	cfg.Scoring.TimeoutMS = 5000
	s := &Server{Store: db, Config: cfg, Service: &engine.Service{Store: db, Config: cfg},
		IngestToken: testIngestToken, AnalystToken: testAnalystToken}
	return &apiFixture{t: t, server: s, handler: s.Routes()}
}

func (f *apiFixture) get(path string) *httptest.ResponseRecorder {
	f.t.Helper()
	return request(f.t, f.handler, "GET", path, testAnalystToken, nil)
}

func (f *apiFixture) post(path string, body any) *httptest.ResponseRecorder {
	f.t.Helper()
	return request(f.t, f.handler, "POST", path, testAnalystToken, body)
}

func (f *apiFixture) email(at time.Time, asn int, domain string) *event.Event {
	f.n++
	return &event.Event{
		EventID: fmt.Sprintf("event_%d", f.n), Type: event.TypeEmailSend, OccurredAt: at,
		AccountID: "account", APIKeyID: "key", Source: "api",
		Network: event.Network{IP: "203.0.113.9", ASN: asn, ASNOrg: "test network"},
		Email: &event.Email{From: "billing@acme.com", To: event.StringList{"private-recipient@example.org"},
			HTML: `<a href="https://` + domain + `/private-path">private-body-marker</a>`},
	}
}

func (f *apiFixture) ingest(ev *event.Event, wantAction string) DecisionResponse {
	f.t.Helper()
	d := decodeResponse[DecisionResponse](f.t, request(f.t, f.handler, "POST", "/v1/events", testIngestToken, ev))
	if d.Unscored || d.DecisionID == "" || d.Action != wantAction {
		f.t.Fatalf("ingest %s: %+v, want scored %s", ev.EventID, d, wantAction)
	}
	return d
}

func (f *apiFixture) history() {
	f.t.Helper()
	for i := 60; i > 0; i-- {
		f.ingest(f.email(testNow.Add(-time.Duration(i)*time.Hour), 16509, "stripe.com"), "allow")
	}
}

func (f *apiFixture) learned() profile.Profile {
	f.t.Helper()
	return decodeResponse[struct {
		Profile profile.Profile `json:"profile"`
	}](f.t, f.get("/v1/accounts/account/profile")).Profile
}

type decisionDetail struct {
	Decision store.Decision        `json:"decision"`
	Event    store.TimelineRow     `json:"event"`
	Actions  []store.AnalystAction `json:"actions"`
}

func (f *apiFixture) detail(id string) decisionDetail {
	f.t.Helper()
	return decodeResponse[decisionDetail](f.t, f.get("/v1/decisions/"+id))
}

func (f *apiFixture) action(id, action string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.post("/v1/decisions/"+id+"/actions", actionRequest{Action: action, Actor: "reviewer", Reason: "reviewed evidence"})
}

func TestAnalystReadEndpoints(t *testing.T) {
	f := newAPIFixture(t)
	f.history()
	f.ingest(f.email(testNow, 14061, "stripe.com"), "flag")
	hold := f.ingest(f.email(testNow.Add(time.Minute), 14061, "invoice-portal.net"), "hold")
	block := f.ingest(f.email(testNow.Add(2*time.Minute), 14061, "acrne.com"), "block")

	stats := decodeResponse[store.Stats](t, f.get("/v1/stats"))
	if stats.Totals != (store.Totals{Events: 63, Allow: 60, Flag: 1, Hold: 1, Block: 1}) {
		t.Fatalf("totals: %+v", stats.Totals)
	}
	if len(stats.Series) != 1 || stats.Series[0].Flag != 1 || stats.Series[0].Hold != 1 || stats.Series[0].Block != 1 {
		t.Errorf("stats series: %+v", stats.Series)
	}
	if len(stats.ReviewQueue) != 1 || stats.ReviewQueue[0].OpenCount != 3 || stats.ReviewQueue[0].MaxAction != "block" {
		t.Errorf("review queue: %+v", stats.ReviewQueue)
	}
	if len(stats.TopSignals) != 4 || stats.TopSignals[0] != (store.SignalCount{Name: "new_asn", Count: 3}) {
		t.Errorf("top signals: %+v", stats.TopSignals)
	}
	for _, bucket := range []string{"1h", "1d"} {
		ranged := decodeResponse[store.Stats](t, f.get("/v1/stats?bucket="+bucket+"&from="+testNow.Format(time.RFC3339)+"&to="+testNow.Add(time.Minute).Format(time.RFC3339)))
		if ranged.Totals != (store.Totals{Events: 1, Flag: 1}) {
			t.Errorf("range must include from and exclude to: %+v", ranged.Totals)
		}
	}
	accounts := decodeResponse[[]store.AccountSummary](t, f.get("/v1/accounts?q=account&needs_review=true"))
	if len(accounts) != 1 || accounts[0].OpenReviews != 3 || accounts[0].Decisions != 63 || accounts[0].LastAction == nil || *accounts[0].LastAction != "block" {
		t.Fatalf("accounts: %+v", accounts)
	}
	if got := decodeResponse[[]store.AccountSummary](t, f.get("/v1/accounts?q=missing")); len(got) != 0 {
		t.Errorf("search returned unrelated accounts: %+v", got)
	}
	timelineResponse := f.get("/v1/accounts/account/timeline?limit=2")
	timeline := decodeResponse[[]store.TimelineRow](t, timelineResponse)
	if len(timeline) != 2 || *timeline[0].DecisionID != hold.DecisionID || *timeline[1].DecisionID != block.DecisionID {
		t.Fatalf("latest two events should be chronological: %+v", timeline)
	}
	for _, secret := range []string{"private-recipient", "private-body-marker", "private-path", "billing@acme.com"} {
		if strings.Contains(timelineResponse.Body.String(), secret) {
			t.Errorf("timeline leaked email data: %s", secret)
		}
	}
	series := decodeResponse[struct {
		Baseline float64       `json:"baseline_hourly"`
		Spike    float64       `json:"spike_threshold"`
		Points   []seriesPoint `json:"points"`
	}](t, f.get("/v1/accounts/account/series?from="+testNow.Format(time.RFC3339)))
	if series.Baseline != 1 || series.Spike != 30 || len(series.Points) != 1 {
		t.Fatalf("series: %+v", series)
	}
	pt := series.Points[0]
	if pt.Recipients != 3 || pt.Actions["block"] != 1 || len(pt.ASNs) != 1 || !pt.ASNs[0].FirstSeen || !slices.Contains(pt.ContentHits, "lookalike_domain") {
		t.Errorf("series aggregation: %+v", pt)
	}
	keys := decodeResponse[struct {
		Profile profile.Profile   `json:"profile"`
		Keys    []store.KeyStatus `json:"key_status"`
	}](t, f.get("/v1/accounts/account/profile"))
	if keys.Profile.EventsSeen != 60 || len(keys.Keys) != 1 || keys.Keys[0].Status != "suspended" {
		t.Errorf("profile and keys: %+v", keys)
	}
	detail := f.detail(block.DecisionID)
	if detail.Decision.Score != 100 || detail.Event.EventID != block.EventID || len(detail.Actions) != 0 {
		t.Errorf("decision detail: %+v", detail)
	}
	requireStatus(t, request(t, f.handler, "GET", "/healthz", "", nil), 200)
}

func TestAnalystEmptyAndMissingResources(t *testing.T) {
	f := newAPIFixture(t)
	stats := decodeResponse[store.Stats](t, f.get("/v1/stats"))
	if stats.Totals.Events != 0 || len(stats.ReviewQueue) != 0 || len(stats.Series) != 0 {
		t.Errorf("empty stats: %+v", stats)
	}
	for _, path := range []string{"/v1/accounts", "/v1/accounts/missing/timeline"} {
		if got := decodeResponse[[]any](t, f.get(path)); len(got) != 0 {
			t.Errorf("%s: %+v", path, got)
		}
	}
	for _, path := range []string{"/v1/accounts/missing/profile", "/v1/accounts/missing/series", "/v1/decisions/" + testDecisionID} {
		requireStatus(t, f.get(path), 404)
	}
	requireStatus(t, f.action(testDecisionID, engine.ActReleaseHold), 404)
	requireStatus(t, f.post("/v1/keys/missing/unblock", actionRequest{Actor: "reviewer", Reason: "reviewed"}), 404)
	requireStatus(t, f.post("/v1/holds/"+testDecisionID+"/owner-response", `{"response":"not_me"}`), 404)
}

func TestAnalystSeriesPreservesASNHistoryOutsideRange(t *testing.T) {
	f := newAPIFixture(t)
	f.history()
	f.ingest(f.email(testNow, 16509, "stripe.com"), "allow")
	change := f.email(testNow.Add(time.Minute), 16509, "")
	change.Type, change.Email, change.Change = event.TypeAccountChange, nil, &event.Change{Kind: "api_key.created", TargetID: "new-key"}
	f.ingest(change, "allow")
	read := f.email(testNow.Add(2*time.Minute), 16509, "")
	read.Type, read.Email, read.Read = event.TypeAPIRead, nil, &event.Read{Resource: "contacts", Status: 403}
	f.ingest(read, "allow")
	series := decodeResponse[struct {
		Points []seriesPoint `json:"points"`
	}](t, f.get("/v1/accounts/account/series?from="+testNow.Format(time.RFC3339)))
	if len(series.Points) != 1 {
		t.Fatalf("series: %+v", series)
	}
	pt := series.Points[0]
	if pt.Recipients != 1 || pt.AccountChanges != 1 || pt.Actions["allow"] != 3 || len(pt.ASNs) != 1 || pt.ASNs[0].FirstSeen {
		t.Errorf("same ASN should remain familiar outside query range: %+v", pt)
	}
	timeline := decodeResponse[[]store.TimelineRow](t, f.get("/v1/accounts/account/timeline?from="+change.OccurredAt.Format(time.RFC3339)+"&to="+read.OccurredAt.Format(time.RFC3339)))
	if len(timeline) != 1 || timeline[0].ChangeKind == nil || *timeline[0].ChangeKind != "api_key.created" {
		t.Errorf("timeline bounds and account-change metadata: %+v", timeline)
	}
	p := f.learned()
	if p.LastChangeAt == nil || !p.LastChangeAt.Equal(change.OccurredAt) || !slices.Contains(p.ReadResources, "contacts") {
		t.Errorf("change/read profile: %+v", p)
	}
}

func TestAnalystReleaseConfirmAndUnblock(t *testing.T) {
	f := newAPIFixture(t)
	f.history()
	h1 := f.ingest(f.email(testNow, 14061, "invoice-portal.net"), "hold")
	h2 := f.ingest(f.email(testNow.Add(time.Second), 14061, "invoice-portal.net"), "hold")
	h3 := f.ingest(f.email(testNow.Add(2*time.Second), 14061, "invoice-portal.net"), "hold")
	d := decodeResponse[store.Decision](t, f.action(h1.DecisionID, engine.ActReleaseHold))
	if d.HoldStatus == nil || *d.HoldStatus != "released" || d.ReviewStatus != "resolved" || d.Label != nil || f.learned().EventsSeen != 60 {
		t.Fatalf("release changed baseline or wrong status: %+v", d)
	}
	requireStatus(t, f.action(h1.DecisionID, engine.ActReleaseHold), 409)
	d = decodeResponse[store.Decision](t, f.action(h2.DecisionID, engine.ActConfirmTakeover))
	if d.Label == nil || *d.Label != "takeover" || *f.detail(h3.DecisionID).Decision.HoldStatus != "dropped" {
		t.Fatalf("confirm didn't drop pending holds: %+v", d)
	}
	requireStatus(t, f.action(h2.DecisionID, engine.ActConfirmTakeover), 409)
	f.ingest(f.email(testNow.Add(time.Minute), 16509, "stripe.com"), "block")
	requireStatus(t, f.post("/v1/keys/key/unblock", actionRequest{Actor: "reviewer", Reason: "owner rotated key"}), 200)
	f.ingest(f.email(testNow.Add(2*time.Minute), 16509, "stripe.com"), "allow")
	requireStatus(t, f.post("/v1/keys/key/unblock", actionRequest{Actor: "reviewer", Reason: "again"}), 409)
	detail := f.detail(h2.DecisionID)
	if len(detail.Actions) != 1 || detail.Actions[0].Action != engine.ActConfirmTakeover || detail.Actions[0].Actor != "reviewer" || detail.Actions[0].Reason != "reviewed evidence" {
		t.Errorf("audit history: %+v", detail.Actions)
	}
}

func TestAnalystMarkLegitimateLearnsExactlyOnce(t *testing.T) {
	f := newAPIFixture(t)
	f.history()
	d := f.ingest(f.email(testNow, 14061, "stripe.com"), "flag")
	requireStatus(t, f.action(d.DecisionID, engine.ActMarkLegitimate), 200)
	requireStatus(t, f.action(d.DecisionID, engine.ActMarkLegitimate), 409)
	p := f.learned()
	if p.EventsSeen != 61 || p.KeyASNs["key"]["14061"] != 1 || p.KnownDomains["stripe.com"] != 61 {
		t.Fatalf("baseline after review: %+v", p)
	}
	f.ingest(f.email(testNow.Add(time.Minute), 14061, "stripe.com"), "allow")
}

func TestAnalystMarkAlreadyAllowedDoesNotDoubleLearn(t *testing.T) {
	f := newAPIFixture(t)
	d := f.ingest(f.email(testNow, 16509, "stripe.com"), "allow")
	requireStatus(t, f.action(d.DecisionID, engine.ActMarkLegitimate), 200)
	p := f.learned()
	if p.EventsSeen != 1 || p.KnownDomains["stripe.com"] != 1 || p.HourBucketRecipients != 1 {
		t.Fatalf("already allowed event was learned twice: %+v", p)
	}
}

func TestOwnerResponsesAndExpiredHold(t *testing.T) {
	for _, response := range []string{"this_was_me", "not_me", "expired"} {
		t.Run(response, func(t *testing.T) {
			f := newAPIFixture(t)
			f.history()
			h := f.ingest(f.email(testNow, 14061, "invoice-portal.net"), "hold")
			path := "/v1/holds/" + h.DecisionID + "/owner-response"
			if response == "expired" {
				_, err := f.server.Store.Pool.Exec(context.Background(), `update decisions set hold_expires_at = now() - interval '1 minute' where decision_id = $1::uuid`, h.DecisionID)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := store.ExpireHolds(context.Background(), f.server.Store.Pool); err != nil {
					t.Fatal(err)
				}
				requireStatus(t, f.post(path, `{"response":"this_was_me"}`), 409)
				requireStatus(t, f.action(h.DecisionID, engine.ActReleaseHold), 409)
				if d := f.detail(h.DecisionID).Decision; *d.HoldStatus != "expired" || d.ReviewStatus != "open" {
					t.Errorf("expired decision: %+v", d)
				}
				return
			}
			d := decodeResponse[store.Decision](t, f.post(path, map[string]string{"response": response}))
			if response == "this_was_me" {
				p := f.learned()
				if *d.HoldStatus != "released" || *d.Label != "legitimate" || p.EventsSeen != 61 || p.KnownDomains["invoice-portal.net"] != 1 {
					t.Fatalf("owner confirmation: %+v profile=%+v", d, p)
				}
			} else {
				if *d.HoldStatus != "dropped" || *d.Label != "takeover" || f.learned().EventsSeen != 60 {
					t.Fatalf("owner denial: %+v", d)
				}
				f.ingest(f.email(testNow.Add(time.Minute), 16509, "stripe.com"), "block")
			}
			detail := f.detail(h.DecisionID)
			wantAction := map[string]string{"this_was_me": "owner_this_was_me", "not_me": "owner_not_me"}[response]
			if len(detail.Actions) != 1 || detail.Actions[0].Actor != "owner" || detail.Actions[0].Action != wantAction {
				t.Errorf("owner audit: %+v", detail.Actions)
			}
			requireStatus(t, f.post(path, map[string]string{"response": response}), 409)
		})
	}
}

func TestConcurrentAnalystReviewsTeachOnce(t *testing.T) {
	f := newAPIFixture(t)
	f.history()
	d := f.ingest(f.email(testNow, 14061, "stripe.com"), "flag")
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for range 2 {
		wg.Go(func() { codes <- f.action(d.DecisionID, engine.ActMarkLegitimate).Code })
	}
	wg.Wait()
	close(codes)
	var got []int
	for code := range codes {
		got = append(got, code)
	}
	slices.Sort(got)
	if !slices.Equal(got, []int{200, 409}) || f.learned().EventsSeen != 61 || len(f.detail(d.DecisionID).Actions) != 1 {
		t.Errorf("concurrent reviews: statuses=%v", got)
	}
}

func TestIngestDuplicateAndShadowMode(t *testing.T) {
	f := newAPIFixture(t)
	f.history()
	f.server.Config.Mode = "shadow"
	ev := f.email(testNow, 14061, "acrne.com")
	first := f.ingest(ev, "allow")
	second := f.ingest(ev, "allow")
	if first.DecisionID != second.DecisionID || first.Enforced || first.Score != 100 || second.LatencyUS != first.LatencyUS {
		t.Fatalf("shadow or duplicate response: first=%+v second=%+v", first, second)
	}
	d := f.detail(first.DecisionID).Decision
	if d.Action != "block" || d.Enforced || d.HoldStatus != nil || f.learned().EventsSeen != 60 {
		t.Fatalf("shadow decision: %+v", d)
	}
	suspended, err := store.KeySuspended(context.Background(), f.server.Store.Pool, "key")
	if err != nil || suspended {
		t.Fatalf("shadow suspended key: %v, %v", suspended, err)
	}
}

func TestDatabaseOutageFailsOpenOnlyForIngest(t *testing.T) {
	f := newAPIFixture(t)
	f.server.Store.Close()
	d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, f.email(testNow, 16509, "stripe.com")))
	if d.Action != "allow" || !d.Unscored || d.Enforced || d.DecisionID != "" || len(d.Hits) != 0 {
		t.Errorf("fail-open response: %+v", d)
	}
	requireStatus(t, f.get("/v1/stats"), 500)
	w := request(t, f.handler, "GET", "/healthz", "", nil)
	if w.Code != 503 {
		t.Errorf("health status = %d, want 503", w.Code)
	}
}

func TestScoringTimeoutRollsBackAndCanBeRetried(t *testing.T) {
	f := newAPIFixture(t)
	f.ingest(f.email(testNow, 16509, "stripe.com"), "allow")
	tx, err := f.server.Store.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(context.Background(), `select account_id from profiles where account_id = 'account' for update`); err != nil {
		t.Fatal(err)
	}
	originalTimeoutMS := f.server.Config.Scoring.TimeoutMS
	f.server.Config.Scoring.TimeoutMS = 30
	ev := f.email(testNow.Add(time.Minute), 16509, "stripe.com")
	d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
	if !d.Unscored || d.Action != "allow" || d.DecisionID != "" {
		t.Fatalf("timed-out request: %+v", d)
	}
	if err := tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	var persisted bool
	if err := f.server.Store.Pool.QueryRow(context.Background(), `select exists(select 1 from events where event_id = $1)`, ev.EventID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if persisted || f.learned().EventsSeen != 1 {
		t.Fatal("timed-out transaction persisted the event or changed the baseline")
	}
	f.server.Config.Scoring.TimeoutMS = originalTimeoutMS
	f.ingest(ev, "allow")
	if f.learned().EventsSeen != 2 {
		t.Fatal("retry was not learned exactly once")
	}
}
