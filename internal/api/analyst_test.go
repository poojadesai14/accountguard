package api

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/poojadesai14/accountguard/internal/config"
	"github.com/poojadesai14/accountguard/internal/engine"
	"github.com/poojadesai14/accountguard/internal/event"
	"github.com/poojadesai14/accountguard/internal/metrics"
	"github.com/poojadesai14/accountguard/internal/profile"
	"github.com/poojadesai14/accountguard/internal/store"
	"github.com/poojadesai14/accountguard/migrations"
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
	cfg, err := config.LoadAt("../../config.yaml", testNow)
	if err != nil {
		t.Fatal(err)
	}
	// Functional integration tests must tolerate race instrumentation and shared
	// CI scheduling. The timeout test below explicitly sets its own short limit.
	cfg.Scoring.TimeoutMS = 5000
	m := metrics.New()
	// The suspended-key lookup after a scoring failure has a tight production
	// budget; shared CI runners under the race detector can exceed it.
	s := &Server{Store: db, Config: cfg, Service: &engine.Service{Store: db, Config: cfg, Metrics: m},
		IngestToken: testIngestToken, AnalystToken: testAnalystToken, Metrics: m,
		SuspendedCheckTimeout: 5 * time.Second}
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
	Decision   store.Decision           `json:"decision"`
	Event      store.TimelineRow        `json:"event"`
	Actions    []store.AnalystAction    `json:"actions"`
	Thresholds Thresholds               `json:"thresholds"`
	Related    []store.RelatedIndicator `json:"related"`
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

	// These cases share a read-only fixture; each checks one HTTP response.
	tests := []struct {
		name, path string
		public     bool
		check      func(*testing.T, *httptest.ResponseRecorder)
	}{
		{
			name: "statistics include totals series queue and top signals",
			path: "/v1/stats",
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[store.Stats](t, w)
				if got.Totals != (store.Totals{Events: 63, Allow: 60, Flag: 1, Hold: 1, Block: 1}) {
					t.Errorf("totals = %+v, want 63 events with 60 allow and one of each elevated action", got.Totals)
				}
				if len(got.Series) != 1 || got.Series[0].Flag != 1 || got.Series[0].Hold != 1 || got.Series[0].Block != 1 {
					t.Errorf("series = %+v, want one bucket with flag:1 hold:1 block:1", got.Series)
				}
				if len(got.ReviewQueue) != 1 || got.ReviewQueue[0].OpenCount != 2 || got.ReviewQueue[0].MaxAction != "block" {
					t.Errorf("review queue = %+v, want one account with two open reviews (hold, block; flags are not queued) and maximum block", got.ReviewQueue)
				}
				if len(got.TopSignals) != 4 || got.TopSignals[0] != (store.SignalCount{Name: "new_asn", Count: 3}) {
					t.Errorf("top signals = %+v, want four signals led by new_asn:3", got.TopSignals)
				}
			},
		},
		{
			name: "hourly range includes from and excludes to",
			path: "/v1/stats?bucket=1h&from=" + testNow.Format(time.RFC3339) + "&to=" + testNow.Add(time.Minute).Format(time.RFC3339),
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[store.Stats](t, w)
				if got.Totals != (store.Totals{Events: 1, Flag: 1}) {
					t.Errorf("totals = %+v, want one flagged event", got.Totals)
				}
			},
		},
		{
			name: "daily range includes from and excludes to",
			path: "/v1/stats?bucket=1d&from=" + testNow.Format(time.RFC3339) + "&to=" + testNow.Add(time.Minute).Format(time.RFC3339),
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[store.Stats](t, w)
				if got.Totals != (store.Totals{Events: 1, Flag: 1}) {
					t.Errorf("totals = %+v, want one flagged event", got.Totals)
				}
			},
		},
		{
			name: "account search includes review counts and latest action",
			path: "/v1/accounts?q=account&needs_review=true",
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[[]store.AccountSummary](t, w)
				if len(got) != 1 {
					t.Fatalf("accounts = %d, want 1", len(got))
				}
				if got[0].OpenReviews != 2 || got[0].Decisions != 63 || got[0].LastAction == nil || *got[0].LastAction != "block" {
					t.Errorf("account = %+v, want 63 decisions, 2 open reviews, latest block", got[0])
				}
			},
		},
		{
			name: "unmatched account search is empty",
			path: "/v1/accounts?q=missing",
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				if got := decodeResponse[[]store.AccountSummary](t, w); len(got) != 0 {
					t.Errorf("accounts = %+v, want empty", got)
				}
			},
		},
		{
			name: "timeline returns latest events chronologically without private email data",
			path: "/v1/accounts/account/timeline?limit=2",
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[[]store.TimelineRow](t, w)
				if len(got) != 2 {
					t.Fatalf("timeline rows = %d, want 2", len(got))
				}
				if got[0].DecisionID == nil || *got[0].DecisionID != hold.DecisionID || got[1].DecisionID == nil || *got[1].DecisionID != block.DecisionID {
					t.Errorf("timeline = %+v, want hold then block", got)
				}
				for _, secret := range []string{"private-recipient", "private-body-marker", "private-path", "billing@acme.com"} {
					if strings.Contains(w.Body.String(), secret) {
						t.Errorf("timeline leaked %q", secret)
					}
				}
			},
		},
		{
			name: "series aggregates recipients actions network and content",
			path: "/v1/accounts/account/series?from=" + testNow.Format(time.RFC3339),
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[struct {
					Baseline float64       `json:"baseline_hourly"`
					Spike    float64       `json:"spike_threshold"`
					Points   []seriesPoint `json:"points"`
				}](t, w)
				if got.Baseline != 1 || got.Spike != 30 || len(got.Points) != 1 {
					t.Fatalf("series = %+v, want baseline:1 spike:30 one hourly point", got)
				}
				point := got.Points[0]
				if point.Recipients != 3 || point.Actions["block"] != 1 || len(point.ASNs) != 1 || !point.ASNs[0].FirstSeen || !slices.Contains(point.ContentHits, "lookalike_domain") {
					t.Errorf("point = %+v, want three recipients, one block, a new ASN and lookalike hit", point)
				}
			},
		},
		{
			name: "profile keeps allowed history separate from suspended key",
			path: "/v1/accounts/account/profile",
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[struct {
					Profile profile.Profile   `json:"profile"`
					Keys    []store.KeyStatus `json:"key_status"`
				}](t, w)
				if got.Profile.EventsSeen != 60 || len(got.Keys) != 1 || got.Keys[0].Status != "suspended" {
					t.Errorf("profile response = %+v, want 60 learned events and one suspended key", got)
				}
			},
		},
		{
			name: "decision detail includes its event and empty audit history",
			path: "/v1/decisions/" + block.DecisionID,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[decisionDetail](t, w)
				if got.Decision.Score != 100 || got.Event.EventID != block.EventID || len(got.Actions) != 0 {
					t.Errorf("decision detail = %+v, want score:100, original event and no audit entries", got)
				}
				if want := (Thresholds{Flag: 30, Hold: 60, Block: 80, BlockMinCategories: 2, SingleCategoryExempt: []string{"content"}}); !reflect.DeepEqual(got.Thresholds, want) {
					t.Errorf("thresholds = %+v, want the engine's %+v", got.Thresholds, want)
				}
			},
		},
		{
			name:   "health does not require an analyst token",
			path:   "/healthz",
			public: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			token := testAnalystToken
			if tt.public {
				token = ""
			}
			response := request(t, f.handler, "GET", tt.path, token, nil)
			requireStatus(t, response, 200)
			if tt.check != nil {
				tt.check(t, response)
			}
		})
	}
}

func TestAnalystEmptyAndMissingResources(t *testing.T) {
	f := newAPIFixture(t)
	tests := []struct {
		name, method, path            string
		body                          any
		wantStatus                    int
		wantEmptyStats, wantEmptyList bool
	}{
		{
			name:           "empty statistics",
			method:         "GET",
			path:           "/v1/stats",
			wantStatus:     200,
			wantEmptyStats: true,
		},
		{
			name:          "empty accounts",
			method:        "GET",
			path:          "/v1/accounts",
			wantStatus:    200,
			wantEmptyList: true,
		},
		{
			name:          "unknown account has empty timeline",
			method:        "GET",
			path:          "/v1/accounts/missing/timeline",
			wantStatus:    200,
			wantEmptyList: true,
		},
		{
			name:       "unknown profile",
			method:     "GET",
			path:       "/v1/accounts/missing/profile",
			wantStatus: 404,
		},
		{
			name:       "unknown series",
			method:     "GET",
			path:       "/v1/accounts/missing/series",
			wantStatus: 404,
		},
		{
			name:       "unknown decision",
			method:     "GET",
			path:       "/v1/decisions/" + testDecisionID,
			wantStatus: 404,
		},
		{
			name:       "action on unknown decision",
			method:     "POST",
			path:       "/v1/decisions/" + testDecisionID + "/actions",
			body:       actionRequest{Action: engine.ActReleaseHold, Actor: "reviewer", Reason: "reviewed evidence"},
			wantStatus: 404,
		},
		{
			name:       "restore unknown key",
			method:     "POST",
			path:       "/v1/keys/missing/unblock",
			body:       actionRequest{Actor: "reviewer", Reason: "reviewed"},
			wantStatus: 404,
		},
		{
			name:       "owner response for unknown decision",
			method:     "POST",
			path:       "/v1/holds/" + testDecisionID + "/owner-response",
			body:       map[string]string{"response": "not_me"},
			wantStatus: 404,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := request(t, f.handler, tt.method, tt.path, testAnalystToken, tt.body)
			requireStatus(t, response, tt.wantStatus)
			if tt.wantEmptyStats {
				got := decodeResponse[store.Stats](t, response)
				if got.Totals.Events != 0 || len(got.ReviewQueue) != 0 || len(got.Series) != 0 {
					t.Errorf("empty stats = %+v", got)
				}
			}
			if tt.wantEmptyList {
				if got := decodeResponse[[]any](t, response); len(got) != 0 {
					t.Errorf("response = %+v, want empty list", got)
				}
			}
		})
	}
}

func TestAnalystSeriesPreservesASNHistoryOutsideRange(t *testing.T) {
	tests := []struct {
		name                        string
		fromAfter                   time.Duration
		wantRecipients, wantAllowed int
	}{
		{
			name:           "range includes the normal send",
			fromAfter:      0,
			wantRecipients: 1,
			wantAllowed:    3,
		},
		{
			name:           "range starts at account change",
			fromAfter:      time.Minute,
			wantRecipients: 0,
			wantAllowed:    2,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAPIFixture(t)
			f.history()
			f.ingest(f.email(testNow, 16509, "stripe.com"), "allow")
			change := f.email(testNow.Add(time.Minute), 16509, "")
			change.Type, change.Email, change.Change = event.TypeAccountChange, nil, &event.Change{Kind: "api_key.created", TargetID: "new-key"}
			f.ingest(change, "allow")
			read := f.email(testNow.Add(2*time.Minute), 16509, "")
			read.Type, read.Email, read.Read = event.TypeAPIRead, nil, &event.Read{Resource: "contacts", Status: 403}
			f.ingest(read, "allow")
			got := decodeResponse[struct {
				Points []seriesPoint `json:"points"`
			}](t, f.get("/v1/accounts/account/series?from="+testNow.Add(tt.fromAfter).Format(time.RFC3339)))
			if len(got.Points) != 1 {
				t.Fatalf("series buckets = %d, want 1", len(got.Points))
			}
			point := got.Points[0]
			if point.Recipients != tt.wantRecipients || point.AccountChanges != 1 || point.Actions["allow"] != tt.wantAllowed || len(point.ASNs) != 1 || point.ASNs[0].FirstSeen {
				t.Errorf("series point = %+v, want recipients:%d changes:1 allows:%d familiar ASN", point, tt.wantRecipients, tt.wantAllowed)
			}
			timeline := decodeResponse[[]store.TimelineRow](t, f.get("/v1/accounts/account/timeline?from="+change.OccurredAt.Format(time.RFC3339)+"&to="+read.OccurredAt.Format(time.RFC3339)))
			if len(timeline) != 1 || timeline[0].ChangeKind == nil || *timeline[0].ChangeKind != "api_key.created" {
				t.Errorf("timeline = %+v, want only the account change", timeline)
			}
			learned := f.learned()
			if learned.LastChangeAt == nil || !learned.LastChangeAt.Equal(change.OccurredAt) || !slices.Contains(learned.ReadResources, "contacts") {
				t.Errorf("change/read profile = %+v", learned)
			}
		})
	}
}

func TestAnalystReleaseConfirmAndUnblock(t *testing.T) {
	tests := []struct {
		name, action, wantHold, wantLabel, wantOtherHold string
		releaseFirst, restoreKey                         bool
	}{
		{
			name:          "release resolves only the selected hold",
			action:        engine.ActReleaseHold,
			wantHold:      "released",
			wantOtherHold: "pending",
		},
		{
			name:          "confirm drops remaining holds and key access can be restored",
			action:        engine.ActConfirmTakeover,
			releaseFirst:  true,
			wantHold:      "dropped",
			wantLabel:     "takeover",
			wantOtherHold: "dropped",
			restoreKey:    true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAPIFixture(t)
			f.history()
			first := f.ingest(f.email(testNow, 14061, "invoice-portal.net"), "hold")
			selected := f.ingest(f.email(testNow.Add(time.Second), 14061, "invoice-portal.net"), "hold")
			other := f.ingest(f.email(testNow.Add(2*time.Second), 14061, "invoice-portal.net"), "hold")
			if tt.releaseFirst {
				requireStatus(t, f.action(first.DecisionID, engine.ActReleaseHold), 200)
			}
			got := decodeResponse[store.Decision](t, f.action(selected.DecisionID, tt.action))
			if got.HoldStatus == nil || *got.HoldStatus != tt.wantHold || got.ReviewStatus != "resolved" {
				t.Errorf("decision state = hold:%v review:%s, want %s/resolved", got.HoldStatus, got.ReviewStatus, tt.wantHold)
			}
			if tt.wantLabel == "" {
				if got.Label != nil {
					t.Errorf("label = %v, want none", got.Label)
				}
			} else if got.Label == nil || *got.Label != tt.wantLabel {
				t.Errorf("label = %v, want %q", got.Label, tt.wantLabel)
			}
			if sibling := f.detail(other.DecisionID).Decision; sibling.HoldStatus == nil || *sibling.HoldStatus != tt.wantOtherHold {
				t.Errorf("other hold = %v, want %q", sibling.HoldStatus, tt.wantOtherHold)
			}
			if tt.releaseFirst {
				if previous := f.detail(first.DecisionID).Decision; previous.HoldStatus == nil || *previous.HoldStatus != "released" {
					t.Errorf("previously released hold changed: %+v", previous)
				}
			}
			if seen := f.learned().EventsSeen; seen != 60 {
				t.Errorf("action learned %d events, want 60", seen)
			}
			requireStatus(t, f.action(selected.DecisionID, tt.action), 409)
			if tt.restoreKey {
				f.ingest(f.email(testNow.Add(time.Minute), 16509, "stripe.com"), "block")
				if tt.action == "confirm_takeover" {
					// After a confirmed takeover, restoring needs the account ID typed.
					requireStatus(t, f.post("/v1/keys/key/unblock", actionRequest{Actor: "reviewer", Reason: "owner rotated key"}), 409)
					requireStatus(t, f.post("/v1/keys/key/unblock", actionRequest{Confirm: "someone_else", Actor: "reviewer", Reason: "owner rotated key"}), 409)
				}
				requireStatus(t, f.post("/v1/keys/key/unblock", actionRequest{Confirm: "account", Actor: "reviewer", Reason: "owner rotated key"}), 200)
				f.ingest(f.email(testNow.Add(2*time.Minute), 16509, "stripe.com"), "allow")
				requireStatus(t, f.post("/v1/keys/key/unblock", actionRequest{Actor: "reviewer", Reason: "again"}), 409)
			}
			audit := f.detail(selected.DecisionID).Actions
			if len(audit) != 1 || audit[0].Action != tt.action || audit[0].Actor != "reviewer" || audit[0].Reason != "reviewed evidence" {
				t.Errorf("audit = %+v, want one %q by reviewer with its reason", audit, tt.action)
			}
		})
	}
}

func TestAnalystMarkLegitimate(t *testing.T) {
	tests := []struct {
		name                       string
		withHistory                bool
		asn                        int
		initialAction              string
		wantEvents, wantDomainUses int
	}{
		{
			name:           "flagged migration learns exactly once",
			withHistory:    true,
			asn:            14061,
			initialAction:  "flag",
			wantEvents:     61,
			wantDomainUses: 61,
		},
		{
			name:           "already allowed event is not learned twice",
			asn:            16509,
			initialAction:  "allow",
			wantEvents:     1,
			wantDomainUses: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAPIFixture(t)
			if tt.withHistory {
				f.history()
			}
			original := f.ingest(f.email(testNow, tt.asn, "stripe.com"), tt.initialAction)
			requireStatus(t, f.action(original.DecisionID, engine.ActMarkLegitimate), 200)
			requireStatus(t, f.action(original.DecisionID, engine.ActMarkLegitimate), 409)
			learned := f.learned()
			if learned.EventsSeen != tt.wantEvents {
				t.Errorf("learned events = %d, want %d", learned.EventsSeen, tt.wantEvents)
			}
			if got := learned.KeyASNs["key"][fmt.Sprint(tt.asn)]; got != 1 {
				t.Errorf("new network uses = %d, want 1", got)
			}
			if got := learned.KnownDomains["stripe.com"]; got != tt.wantDomainUses {
				t.Errorf("domain uses = %d, want %d", got, tt.wantDomainUses)
			}
			if learned.HourBucketRecipients != 1 {
				t.Errorf("open bucket recipients = %d, want 1", learned.HourBucketRecipients)
			}
			f.ingest(f.email(testNow.Add(time.Minute), tt.asn, "stripe.com"), "allow")
		})
	}
}

func TestOwnerResponsesAndExpiredHold(t *testing.T) {
	tests := []struct {
		name, response, wantHold, wantLabel, wantReview, wantAudit string
		expired, noKey, wantSuspended                              bool
		wantStatus, wantLearned, wantDomainUses                    int
	}{
		{
			name:           "owner recognizes legitimate activity",
			response:       "this_was_me",
			wantStatus:     200,
			wantHold:       "released",
			wantLabel:      "legitimate",
			wantReview:     "resolved",
			wantAudit:      "owner_this_was_me",
			wantLearned:    61,
			wantDomainUses: 1,
		},
		{
			name:          "owner reports takeover",
			response:      "not_me",
			wantStatus:    200,
			wantHold:      "dropped",
			wantLabel:     "takeover",
			wantReview:    "resolved",
			wantAudit:     "owner_not_me",
			wantLearned:   60,
			wantSuspended: true,
		},
		{
			name:        "owner reports takeover of a dashboard send with no key",
			response:    "not_me",
			noKey:       true,
			wantStatus:  200,
			wantHold:    "dropped",
			wantLabel:   "takeover",
			wantReview:  "resolved",
			wantAudit:   "owner_not_me",
			wantLearned: 60,
		},
		{
			name:        "expired hold rejects owner and analyst release",
			response:    "this_was_me",
			expired:     true,
			wantStatus:  409,
			wantHold:    "expired",
			wantReview:  "open",
			wantLearned: 60,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAPIFixture(t)
			f.history()
			held := f.email(testNow, 14061, "invoice-portal.net")
			if tt.noKey {
				// Network history is per key, so a keyless send needs content alone to reach hold.
				held = f.email(testNow, 14061, "acrne.com")
				held.APIKeyID, held.Source = "", "dashboard"
			}
			hold := f.ingest(held, "hold")
			if tt.expired {
				if _, err := f.server.Store.Pool.Exec(context.Background(), `update decisions set hold_expires_at = now() - interval '1 minute' where decision_id = $1::uuid`, hold.DecisionID); err != nil {
					t.Fatal(err)
				}
				if _, err := store.ExpireHolds(context.Background(), f.server.Store.Pool); err != nil {
					t.Fatal(err)
				}
			}
			path := "/v1/holds/" + hold.DecisionID + "/owner-response"
			requireStatus(t, f.post(path, map[string]string{"response": tt.response}), tt.wantStatus)
			detail := f.detail(hold.DecisionID)
			got := detail.Decision
			if got.HoldStatus == nil || *got.HoldStatus != tt.wantHold || got.ReviewStatus != tt.wantReview {
				t.Errorf("owner result = hold:%v review:%s, want %s/%s", got.HoldStatus, got.ReviewStatus, tt.wantHold, tt.wantReview)
			}
			if tt.wantLabel == "" {
				if got.Label != nil {
					t.Errorf("label = %v, want none", got.Label)
				}
			} else if got.Label == nil || *got.Label != tt.wantLabel {
				t.Errorf("label = %v, want %q", got.Label, tt.wantLabel)
			}
			learned := f.learned()
			if learned.EventsSeen != tt.wantLearned || learned.KnownDomains["invoice-portal.net"] != tt.wantDomainUses {
				t.Errorf("baseline = events:%d domain uses:%d, want %d/%d", learned.EventsSeen, learned.KnownDomains["invoice-portal.net"], tt.wantLearned, tt.wantDomainUses)
			}
			if tt.wantAudit == "" {
				if len(detail.Actions) != 0 {
					t.Errorf("rejected response wrote audit entries: %+v", detail.Actions)
				}
			} else if len(detail.Actions) != 1 || detail.Actions[0].Actor != "owner" || detail.Actions[0].Action != tt.wantAudit {
				t.Errorf("audit = %+v, want one owner/%s entry", detail.Actions, tt.wantAudit)
			}
			if tt.wantSuspended {
				f.ingest(f.email(testNow.Add(time.Minute), 16509, "stripe.com"), "block")
			}
			requireStatus(t, f.post(path, map[string]string{"response": tt.response}), 409)
			if tt.expired {
				requireStatus(t, f.action(hold.DecisionID, engine.ActReleaseHold), 409)
			}
		})
	}
}

func TestConcurrentAnalystReviewsTeachOnce(t *testing.T) {
	tests := []struct {
		name      string
		reviewers int
	}{
		{
			name:      "two reviewers",
			reviewers: 2,
		},
		{
			name:      "five reviewers",
			reviewers: 5,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAPIFixture(t)
			f.history()
			original := f.ingest(f.email(testNow, 14061, "stripe.com"), "flag")
			var group sync.WaitGroup
			statuses := make(chan int, tt.reviewers)
			for range tt.reviewers {
				group.Go(func() { statuses <- f.action(original.DecisionID, engine.ActMarkLegitimate).Code })
			}
			group.Wait()
			close(statuses)
			successes, conflicts := 0, 0
			for status := range statuses {
				switch status {
				case 200:
					successes++
				case 409:
					conflicts++
				default:
					t.Errorf("unexpected concurrent response: HTTP %d", status)
				}
			}
			if successes != 1 || conflicts != tt.reviewers-1 {
				t.Errorf("responses = success:%d conflict:%d, want 1/%d", successes, conflicts, tt.reviewers-1)
			}
			if learned := f.learned().EventsSeen; learned != 61 {
				t.Errorf("learned events = %d, want 61", learned)
			}
			if audit := f.detail(original.DecisionID).Actions; len(audit) != 1 {
				t.Errorf("audit entries = %d, want 1", len(audit))
			}
		})
	}
}

func TestIngestDuplicateAndShadowMode(t *testing.T) {
	tests := []struct {
		name, mode, wantResponseAction string
		wantEnforced, wantSuspended    bool
	}{
		{
			name:               "enforcement blocks and suspends once",
			mode:               "enforce",
			wantResponseAction: "block",
			wantEnforced:       true,
			wantSuspended:      true,
		},
		{
			name:               "shadow computes block without enforcement",
			mode:               "shadow",
			wantResponseAction: "allow",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAPIFixture(t)
			f.history()
			f.server.Config.Mode = tt.mode
			ev := f.email(testNow, 14061, "acrne.com")
			first := f.ingest(ev, tt.wantResponseAction)
			second := f.ingest(ev, tt.wantResponseAction)
			if first.DecisionID != second.DecisionID || first.Enforced != tt.wantEnforced || first.Score != 100 || second.LatencyUS != first.LatencyUS {
				t.Errorf("responses differ from expected idempotent result: first=%+v second=%+v", first, second)
			}
			stored := f.detail(first.DecisionID).Decision
			if stored.Action != "block" || stored.Enforced != tt.wantEnforced || stored.HoldStatus != nil {
				t.Errorf("stored decision = %+v, want block with enforced:%v and no hold", stored, tt.wantEnforced)
			}
			if learned := f.learned().EventsSeen; learned != 60 {
				t.Errorf("attack learned %d events, want baseline unchanged at 60", learned)
			}
			suspended, err := store.KeySuspended(context.Background(), f.server.Store.Pool, "key")
			if err != nil {
				t.Fatal(err)
			}
			if suspended != tt.wantSuspended {
				t.Errorf("key suspended = %v, want %v", suspended, tt.wantSuspended)
			}
		})
	}
}

func TestDatabaseOutageFailsOpenOnlyForIngest(t *testing.T) {
	tests := []struct {
		name, method, path, token   string
		wantStatus                  int
		wantUnscored, wantPlainText bool
	}{
		{
			name:         "ingestion fails open",
			method:       "POST",
			path:         "/v1/events",
			token:        testIngestToken,
			wantStatus:   200,
			wantUnscored: true,
		},
		{
			name:       "statistics fail closed",
			method:     "GET",
			path:       "/v1/stats",
			token:      testAnalystToken,
			wantStatus: 500,
		},
		{
			name:       "dashboard fails closed",
			method:     "GET",
			path:       "/v1/dashboard",
			token:      testAnalystToken,
			wantStatus: 500,
		},
		{
			name:       "audit feed fails closed",
			method:     "GET",
			path:       "/v1/analyst-actions",
			token:      testAnalystToken,
			wantStatus: 500,
		},
		{
			name:          "health reports database outage",
			method:        "GET",
			path:          "/healthz",
			wantStatus:    503,
			wantPlainText: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAPIFixture(t)
			f.server.Store.Close()
			var body any
			if tt.wantUnscored {
				body = f.email(testNow, 16509, "stripe.com")
			}
			response := request(t, f.handler, tt.method, tt.path, tt.token, body)
			if tt.wantPlainText {
				if response.Code != tt.wantStatus {
					t.Errorf("HTTP %d, want %d", response.Code, tt.wantStatus)
				}
				return
			}
			requireStatus(t, response, tt.wantStatus)
			if tt.wantUnscored {
				got := decodeResponse[DecisionResponse](t, response)
				if got.Action != "allow" || !got.Unscored || got.Enforced || got.DecisionID != "" || len(got.Hits) != 0 {
					t.Errorf("fail-open response = %+v, want unscored allow with no enforcement, decision or hits", got)
				}
			}
		})
	}
}

func TestSuspendedKeyStaysStopped(t *testing.T) {
	tests := []struct {
		name, mode   string
		scoringFails bool
		wantUnscored bool
	}{
		{name: "shadow mode still rejects a suspended key", mode: "shadow"},
		{name: "scoring timeout still rejects a suspended key", mode: "enforce", scoringFails: true, wantUnscored: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAPIFixture(t)
			f.server.Config.Mode = tt.mode
			f.ingest(f.email(testNow, 16509, "stripe.com"), "allow")
			if err := store.SuspendKey(context.Background(), f.server.Store.Pool, "key", "account", "analyst", ""); err != nil {
				t.Fatal(err)
			}
			if tt.scoringFails {
				tx, err := f.server.Store.Pool.Begin(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				if _, err := tx.Exec(context.Background(), `lock table events in access exclusive mode`); err != nil {
					t.Fatal(err)
				}
				f.server.Config.Scoring.TimeoutMS = 30
			}
			ev := f.email(testNow.Add(time.Minute), 16509, "stripe.com")
			got := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
			if got.Action != "block" || !got.Enforced || got.Unscored != tt.wantUnscored || got.Reason == nil || *got.Reason != engine.ReasonKeySuspended {
				t.Errorf("response = %+v, want enforced block for key_suspended with unscored:%v", got, tt.wantUnscored)
			}
		})
	}
}

func TestScoringPanicFailsOpen(t *testing.T) {
	f := newAPIFixture(t)
	f.server.Service = &engine.Service{Store: f.server.Store}
	got := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, f.email(testNow, 16509, "stripe.com")))
	if got.Action != "allow" || !got.Unscored || got.Enforced {
		t.Errorf("response = %+v, want unscored allow", got)
	}
}

func TestScoringTimeoutRollsBackAndCanBeRetried(t *testing.T) {
	tests := []struct{ name, blockingSQL string }{
		{
			name:        "waiting for profile row lock",
			blockingSQL: `select account_id from profiles where account_id = 'account' for update`,
		},
		{
			name:        "waiting to insert event",
			blockingSQL: `lock table events in access exclusive mode`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAPIFixture(t)
			f.ingest(f.email(testNow, 16509, "stripe.com"), "allow")
			tx, err := f.server.Store.Pool.Begin(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(context.Background(), tt.blockingSQL); err != nil {
				t.Fatal(err)
			}
			originalTimeout := f.server.Config.Scoring.TimeoutMS
			f.server.Config.Scoring.TimeoutMS = 30
			ev := f.email(testNow.Add(time.Minute), 16509, "stripe.com")
			timedOut := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
			if !timedOut.Unscored || timedOut.Action != "allow" || timedOut.DecisionID != "" {
				t.Errorf("timed-out response = %+v, want unscored allow without decision", timedOut)
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
			f.server.Config.Scoring.TimeoutMS = originalTimeout
			f.ingest(ev, "allow")
			if learned := f.learned().EventsSeen; learned != 2 {
				t.Errorf("learned events after retry = %d, want 2", learned)
			}
		})
	}
}

func TestConfigEndpoint(t *testing.T) {
	f := newAPIFixture(t)
	type config struct {
		Mode          string     `json:"mode"`
		ConfigVersion string     `json:"config_version"`
		Thresholds    Thresholds `json:"thresholds"`
	}
	tests := []struct {
		name       string
		token      string
		wantStatus int
		wantConfig bool
	}{
		{name: "ingest token is refused", token: testIngestToken, wantStatus: http.StatusUnauthorized},
		{name: "no token is refused", token: "", wantStatus: http.StatusUnauthorized},
		{name: "analyst token reads mode, version and thresholds", token: testAnalystToken, wantStatus: http.StatusOK, wantConfig: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := request(t, f.handler, "GET", "/v1/config", tt.token, nil)
			requireStatus(t, w, tt.wantStatus)
			if !tt.wantConfig {
				return
			}
			got := decodeResponse[config](t, w)
			want := config{Mode: f.server.Config.Mode, ConfigVersion: f.server.Config.Version, Thresholds: f.server.thresholds()}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("config = %+v, want %+v", got, want)
			}
		})
	}
}

// A created key is listed even before it sends, so an attacker's backup key can be
// found and suspended. Steps run in order on one account.
func TestProfileListsCreatedKeys(t *testing.T) {
	f := newAPIFixture(t)
	f.history()
	change := func(at time.Duration, kind, key string) {
		t.Helper()
		ev := f.email(testNow.Add(at), 16509, "")
		ev.Type, ev.Email, ev.Change = event.TypeAccountChange, nil, &event.Change{Kind: kind, TargetID: key}
		decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
	}
	type created struct {
		APIKeyID  string    `json:"api_key_id"`
		CreatedAt time.Time `json:"created_at"`
	}
	tests := []struct {
		name string
		do   func()
		want []string // newest first
	}{
		{name: "no key created: none listed", do: func() {}, want: nil},
		{name: "a created key is listed though it never sent", do: func() { change(time.Minute, "api_key.created", "backup") }, want: []string{"backup"}},
		{name: "newest first", do: func() { change(2*time.Minute, "api_key.created", "second") }, want: []string{"second", "backup"}},
		{name: "a deleted key drops off", do: func() { change(3*time.Minute, "api_key.deleted", "backup") }, want: []string{"second"}},
		{name: "a key created again after deletion is back", do: func() { change(4*time.Minute, "api_key.created", "backup") }, want: []string{"backup", "second"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.do()
			got := decodeResponse[struct {
				CreatedKeys []created `json:"created_keys"`
			}](t, f.get("/v1/accounts/account/profile")).CreatedKeys
			var ids []string
			for _, k := range got {
				ids = append(ids, k.APIKeyID)
			}
			if !slices.Equal(ids, tt.want) {
				t.Errorf("created_keys = %v, want %v", ids, tt.want)
			}
		})
	}
}
