package api

import (
	"context"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/store"
)

type dashboardDecisionInput struct {
	account, key, action string
	score                int
	at                   time.Time
	review               string
	label, hold, reason  *string
}

func dashboardDecision(t *testing.T, f *apiFixture, input dashboardDecisionInput) string {
	t.Helper()
	ctx := context.Background()
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into profiles(account_id,first_seen_at,events_seen,active_hours) values($1,$2,100,100) on conflict do nothing`, input.account, input.at); err != nil {
		t.Fatal(err)
	}
	eventID := fmt.Sprintf("%s_%s_%d", input.account, input.action, input.at.UnixNano())
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into events(event_id,type,occurred_at,account_id,api_key_id,source,ip,asn,asn_org) values($1,'email.send',$2,$3,$4,'api','203.0.113.9',14061,'DigitalOcean')`, eventID, input.at, input.account, input.key); err != nil {
		t.Fatal(err)
	}
	var id string
	err := f.server.Store.Pool.QueryRow(ctx, `insert into decisions(event_id,account_id,api_key_id,occurred_at,action,enforced,score,hits,config_version,review_status,label,hold_status,hold_expires_at,reason)
 values($1,$2,$3,$4,$5,true,$6,'[{"name":"new_asn","category":"network","points":30,"detail":"AS14061 first seen"}]','test',$7,$8,$9,
  case when $9 = 'pending' then $4::timestamptz + interval '24 hours' end, $10) returning decision_id::text`, eventID, input.account, input.key, input.at, input.action, input.score, input.review, input.label, input.hold, input.reason).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func strp(value string) *string { return &value }

// A read-only fixture shared by the classification and filter tables.
func dashboardHistory(t *testing.T) (*apiFixture, map[string]string) {
	t.Helper()
	f := newAPIFixture(t)
	ctx := context.Background()
	decisions := []dashboardDecisionInput{
		{
			account: "multi",
			key:     "key_a",
			action:  "flag",
			score:   45,
			at:      testNow,
			review:  "open",
		},
		{
			account: "multi",
			key:     "key_a",
			action:  "block",
			score:   85,
			at:      testNow.Add(time.Minute),
			review:  "open",
		},
		{
			account: "multi",
			key:     "key_b",
			action:  "hold",
			score:   60,
			at:      testNow.Add(2 * time.Minute),
			review:  "open",
			hold:    strp("pending"),
		},
		{
			account: "multi",
			key:     "key_b",
			action:  "allow",
			score:   0,
			at:      testNow.Add(3 * time.Minute),
			review:  "none",
		},
		{
			account: "approved",
			key:     "key_good",
			action:  "hold",
			score:   75,
			at:      testNow,
			review:  "resolved",
			label:   strp("legitimate"),
			hold:    strp("released"),
		},
		{
			account: "learning",
			key:     "key_learning",
			action:  "allow",
			score:   0,
			at:      testNow,
			review:  "none",
		},
	}
	ids := make(map[string]string)
	for _, input := range decisions {
		ids[input.account+"/"+input.action] = dashboardDecision(t, f, input)
	}
	for _, score := range []int{39, 40, 79, 80} {
		dashboardDecision(t, f, dashboardDecisionInput{account: fmt.Sprintf("edge_%d", score), key: fmt.Sprintf("key_%d", score), action: "flag", score: score, at: testNow, review: "open"})
	}
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into key_status(api_key_id,account_id,status,reason) values('key_a','multi','suspended','analyst'),('key_c','multi','suspended','owner')`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.Store.Pool.Exec(ctx, `update profiles set events_seen=1,active_hours=1 where account_id='learning'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into profiles(account_id,first_seen_at) values('unscored',$1)`, testNow); err != nil {
		t.Fatal(err)
	}
	return f, ids
}
func TestDashboardClassification(t *testing.T) {
	f, ids := dashboardHistory(t)
	type expectedAccount struct {
		account, decision, action, keyStatus string
		score, openReviews, suspendedKeys    int
		baselineReady                        bool
	}
	tests := []struct {
		name, path           string
		wantTotal, wantCount int
		wantAccounts         []expectedAccount
	}{
		{
			name:      "global snapshot counts accounts rather than keys",
			path:      "/v1/dashboard",
			wantTotal: 5,
			wantCount: 5,
		},
		{
			name:      "highest open severity wins over a newer allowed event",
			path:      "/v1/dashboard?q=multi",
			wantTotal: 1,
			wantCount: 1,
			wantAccounts: []expectedAccount{
				{
					account:       "multi",
					decision:      ids["multi/block"],
					action:        "block",
					score:         85,
					openReviews:   3,
					suspendedKeys: 2,
					keyStatus:     "suspended",
					baselineReady: true,
				},
			},
		},
		{
			name:      "approved historical hold and learning baseline are separate",
			path:      "/v1/dashboard?segment=baseline",
			wantTotal: 2,
			wantCount: 2,
			wantAccounts: []expectedAccount{
				{
					account:       "approved",
					decision:      ids["approved/hold"],
					action:        "hold",
					score:         75,
					keyStatus:     "active",
					baselineReady: true,
				},
				{
					account:       "learning",
					decision:      ids["learning/allow"],
					action:        "allow",
					score:         0,
					keyStatus:     "active",
					baselineReady: false,
				},
			},
		},
		{
			name:      "empty page retains the matching account count",
			path:      "/v1/dashboard?page=99",
			wantTotal: 5,
			wantCount: 0,
		},
		{
			name:      "unscored history is not a legitimate baseline",
			path:      "/v1/dashboard?segment=baseline&q=unscored",
			wantTotal: 0,
			wantCount: 0,
		},
	}
	wantMetrics := store.DashboardMetrics{AttentionAccounts: 5, PendingQuarantines: 1, SuspendedKeys: 2, HealthyBaselines: 1}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := decodeResponse[store.Dashboard](t, request(t, f.handler, "GET", tt.path, testAnalystToken, nil))
			if got.Total != tt.wantTotal || len(got.Items) != tt.wantCount {
				t.Fatalf("accounts = total:%d page:%d, want %d/%d", got.Total, len(got.Items), tt.wantTotal, tt.wantCount)
			}
			if got.Items == nil {
				t.Error("items is null, want a JSON array")
			}
			if got.Metrics != wantMetrics {
				t.Errorf("global metrics = %+v, want %+v", got.Metrics, wantMetrics)
			}
			if got.EngineMode != f.server.Config.Mode || got.GeneratedAt.IsZero() {
				t.Errorf("snapshot metadata = mode:%q generated:%v", got.EngineMode, got.GeneratedAt)
			}
			for _, want := range tt.wantAccounts {
				index := slices.IndexFunc(got.Items, func(item store.DashboardAccount) bool { return item.AccountID == want.account })
				if index < 0 {
					t.Fatalf("account %q is missing", want.account)
				}
				item := got.Items[index]
				if item.DecisionID == nil || *item.DecisionID != want.decision {
					t.Errorf("%s decision = %v, want %q", want.account, item.DecisionID, want.decision)
				}
				if item.Action == nil || *item.Action != want.action || item.Score == nil || *item.Score != want.score {
					t.Errorf("%s recorded decision = %v/%v, want %s/%d", want.account, item.Action, item.Score, want.action, want.score)
				}
				if item.OpenReviews != want.openReviews || item.SuspendedKeys != want.suspendedKeys {
					t.Errorf("%s state = reviews:%d suspended:%d, want %d/%d", want.account, item.OpenReviews, item.SuspendedKeys, want.openReviews, want.suspendedKeys)
				}
				if item.KeyStatus == nil || *item.KeyStatus != want.keyStatus || item.BaselineReady != want.baselineReady {
					t.Errorf("%s key/baseline = %v/%v, want %s/%v", want.account, item.KeyStatus, item.BaselineReady, want.keyStatus, want.baselineReady)
				}
			}
		})
	}
}
func TestDashboardFilters(t *testing.T) {
	f, _ := dashboardHistory(t)
	tests := []struct {
		name, query string
		wantTotal   int
		wantScores  []int
	}{
		{
			name:       "block filter matches the decision action",
			query:      "severity=block",
			wantTotal:  1,
			wantScores: []int{85},
		},
		{
			name:       "flag filter matches every flagged score, not a score band",
			query:      "severity=flag",
			wantTotal:  4,
			wantScores: []int{80, 79, 40, 39},
		},
		{
			name:      "related API key",
			query:     "q=key_a",
			wantTotal: 1,
		},
		{
			name:      "source IP",
			query:     "q=203.0.113.9",
			wantTotal: 5,
		},
		{
			name:      "ASN with prefix",
			query:     "q=AS14061",
			wantTotal: 5,
		},
		{
			name:      "human readable signal name",
			query:     "q=" + url.QueryEscape("new asn"),
			wantTotal: 5,
		},
		{
			name:      "percent sign is literal rather than a SQL wildcard",
			query:     "q=%25",
			wantTotal: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := decodeResponse[store.Dashboard](t, request(t, f.handler, "GET", "/v1/dashboard?"+tt.query, testAnalystToken, nil))
			if got.Total != tt.wantTotal {
				t.Errorf("matching accounts = %d, want %d", got.Total, tt.wantTotal)
			}
			if tt.wantScores != nil {
				var scores []int
				for _, item := range got.Items {
					if item.Score == nil {
						t.Fatal("filtered row has no score")
					}
					scores = append(scores, *item.Score)
				}
				if !slices.Equal(scores, tt.wantScores) {
					t.Errorf("filtered scores = %v, want %v", scores, tt.wantScores)
				}
			}
		})
	}
}
func TestDashboardMetricViews(t *testing.T) {
	f, ids := dashboardHistory(t)
	secondHold := dashboardDecision(t, f, dashboardDecisionInput{
		account: "multi",
		key:     "key_a",
		action:  "hold",
		score:   70,
		at:      testNow.Add(4 * time.Minute),
		review:  "open",
		hold:    strp("pending"),
	})
	if _, err := f.server.Store.Pool.Exec(context.Background(), `insert into key_status(api_key_id,account_id,status,reason) values('key_orphan','orphan','suspended','owner')`); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, query, wantView string
		wantTotal             int
		wantKeys              []string
		wantDecisions         []string
	}{
		{
			name:      "attention card counts each account once",
			wantView:  "accounts",
			wantTotal: 5,
		},
		{
			name:          "holds card includes each pending event behind a more severe account decision",
			query:         "view=holds",
			wantView:      "holds",
			wantTotal:     2,
			wantKeys:      []string{"key_a", "key_b"},
			wantDecisions: []string{secondHold, ids["multi/hold"]},
		},
		{
			name:          "held events paginate individually within one account",
			query:         "view=holds&limit=1&page=2",
			wantView:      "holds",
			wantTotal:     2,
			wantKeys:      []string{"key_b"},
			wantDecisions: []string{ids["multi/hold"]},
		},
		{
			name:          "search checks the held event key rather than the account representative",
			query:         "view=holds&q=key_b",
			wantView:      "holds",
			wantTotal:     1,
			wantKeys:      []string{"key_b"},
			wantDecisions: []string{ids["multi/hold"]},
		},
		{
			name:          "key card includes every suspended key including keys without decisions or profiles",
			query:         "view=keys",
			wantView:      "keys",
			wantTotal:     3,
			wantKeys:      []string{"key_a", "key_c", "key_orphan"},
			wantDecisions: []string{ids["multi/block"], "", ""},
		},
		{
			name:          "a suspended key never borrows a decision from another key",
			query:         "view=keys&q=key_c",
			wantView:      "keys",
			wantTotal:     1,
			wantKeys:      []string{"key_c"},
			wantDecisions: []string{""},
		},
		{
			name:          "suspended keys paginate without dropping sibling keys",
			query:         "view=keys&limit=1&page=2",
			wantView:      "keys",
			wantTotal:     3,
			wantKeys:      []string{"key_c"},
			wantDecisions: []string{""},
		},
		{
			name:          "healthy card excludes learning accounts but preserves legitimate historical decisions",
			query:         "segment=baseline&view=healthy",
			wantView:      "healthy",
			wantTotal:     1,
			wantKeys:      []string{"key_good"},
			wantDecisions: []string{ids["approved/hold"]},
		},
		{
			name:      "healthy search does not reintroduce accounts still learning",
			query:     "segment=baseline&view=healthy&q=learning",
			wantView:  "healthy",
			wantTotal: 0,
		},
		{
			name:      "clearing the healthy view includes learning baselines again",
			query:     "segment=baseline",
			wantView:  "accounts",
			wantTotal: 2,
		},
	}
	wantMetrics := store.DashboardMetrics{AttentionAccounts: 5, PendingQuarantines: 2, SuspendedKeys: 3, HealthyBaselines: 1}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := decodeResponse[store.Dashboard](t, request(t, f.handler, "GET", "/v1/dashboard?"+tt.query, testAnalystToken, nil))
			if got.View != tt.wantView || got.Total != tt.wantTotal {
				t.Fatalf("view/total = %q/%d, want %q/%d", got.View, got.Total, tt.wantView, tt.wantTotal)
			}
			if got.Metrics != wantMetrics {
				t.Errorf("global metrics = %+v, want %+v", got.Metrics, wantMetrics)
			}
			var keys, decisions []string
			for _, item := range got.Items {
				if item.APIKeyID == nil {
					t.Fatal("drilldown row is missing its key")
				}
				keys = append(keys, *item.APIKeyID)
				decision := ""
				if item.DecisionID != nil {
					decision = *item.DecisionID
				}
				decisions = append(decisions, decision)
				if got.View == "holds" && (item.HoldStatus == nil || *item.HoldStatus != "pending" || item.HoldExpiresAt == nil) {
					t.Error("held event is not pending or has no expiry")
				}
				if got.View == "keys" && (item.KeyStatus == nil || *item.KeyStatus != "suspended" || item.KeySuspendedBy == nil || item.KeySuspendedAt == nil) {
					t.Error("key is not suspended or is missing who suspended it and when")
				}
				if item.KeyStatus != nil && *item.KeyStatus != "suspended" && (item.KeySuspendedBy != nil || item.KeySuspendedAt != nil) {
					t.Error("an active key reports suspension details")
				}
				if *item.APIKeyID == "key_orphan" && *item.KeySuspendedBy != "owner" {
					t.Errorf("key_orphan suspended by %s, want owner", *item.KeySuspendedBy)
				}
			}
			if tt.wantKeys != nil && !slices.Equal(keys, tt.wantKeys) {
				t.Errorf("keys = %v, want %v", keys, tt.wantKeys)
			}
			if tt.wantDecisions != nil && !slices.Equal(decisions, tt.wantDecisions) {
				t.Errorf("decisions = %v, want %v", decisions, tt.wantDecisions)
			}
		})
	}
}
func TestDashboardMetricViewPaginationTies(t *testing.T) {
	f := newAPIFixture(t)
	var holdIDs []string
	for i := range 3 {
		holdIDs = append(holdIDs, dashboardDecision(t, f, dashboardDecisionInput{
			account: "tied",
			key:     "held_key",
			action:  "hold",
			score:   75,
			at:      testNow.Add(time.Duration(i) * time.Minute),
			review:  "open",
			hold:    strp("pending"),
		}))
	}
	if _, err := f.server.Store.Pool.Exec(context.Background(), `update decisions set occurred_at=$1 where account_id='tied'`, testNow); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.Store.Pool.Exec(context.Background(), `insert into key_status(api_key_id,account_id,status,reason) values('key_z','tied','suspended','owner'),('key_a','tied','suspended','owner')`); err != nil {
		t.Fatal(err)
	}
	slices.Sort(holdIDs)
	tests := []struct {
		name, view string
		wantIDs    []string
	}{
		{
			name:    "held events with identical key score and timestamp",
			view:    "holds",
			wantIDs: holdIDs,
		},
		{
			name:    "sibling suspended keys without any decisions",
			view:    "keys",
			wantIDs: []string{"key_a", "key_z"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for i, wantID := range tt.wantIDs {
				path := fmt.Sprintf("/v1/dashboard?view=%s&limit=1&page=%d", tt.view, i+1)
				got := decodeResponse[store.Dashboard](t, request(t, f.handler, "GET", path, testAnalystToken, nil))
				if got.Total != len(tt.wantIDs) || len(got.Items) != 1 {
					t.Fatalf("page %d total/rows = %d/%d, want %d/1", i+1, got.Total, len(got.Items), len(tt.wantIDs))
				}
				id := got.Items[0].APIKeyID
				if tt.view == "holds" {
					id = got.Items[0].DecisionID
				}
				if id == nil || *id != wantID {
					t.Errorf("page %d ID = %v, want %q", i+1, id, wantID)
				}
			}
		})
	}
}
func TestDashboardSort(t *testing.T) {
	f := newAPIFixture(t)
	decisions := []dashboardDecisionInput{
		{
			account: "sort_block",
			key:     "key_block",
			action:  "block",
			score:   70,
			at:      testNow,
			review:  "open",
		},
		{
			account: "sort_flag_high",
			key:     "key_flag_high",
			action:  "flag",
			score:   95,
			at:      testNow,
			review:  "open",
		},
		{
			account: "sort_hold_old",
			key:     "key_hold_old",
			action:  "hold",
			score:   80,
			at:      testNow.Add(-time.Minute),
			review:  "open",
		},
		{
			account: "sort_hold_a",
			key:     "key_hold_a",
			action:  "hold",
			score:   80,
			at:      testNow,
			review:  "open",
		},
		{
			account: "sort_hold_b",
			key:     "key_hold_b",
			action:  "hold",
			score:   80,
			at:      testNow,
			review:  "open",
		},
		{
			account: "sort_flag_equal",
			key:     "key_flag_equal",
			action:  "flag",
			score:   80,
			at:      testNow.Add(time.Minute),
			review:  "open",
		},
		{
			account: "baseline_low",
			key:     "key_baseline_low",
			action:  "allow",
			score:   5,
			at:      testNow,
			review:  "none",
		},
		{
			account: "baseline_reviewed",
			key:     "key_baseline_reviewed",
			action:  "hold",
			score:   85,
			at:      testNow,
			review:  "resolved",
			label:   strp("legitimate"),
		},
	}
	for _, input := range decisions {
		dashboardDecision(t, f, input)
	}
	ctx := context.Background()
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into profiles(account_id,first_seen_at) values('sort_unscored',$1)`, testNow); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into key_status(api_key_id,account_id,status,reason) values('key_unscored','sort_unscored','suspended','analyst')`); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, query  string
		wantTotal    int
		wantAccounts []string
	}{
		{
			name:         "default puts the most severe action first, then score",
			wantTotal:    7,
			wantAccounts: []string{"sort_block", "sort_hold_a", "sort_hold_b", "sort_hold_old", "sort_flag_high", "sort_flag_equal", "sort_unscored"},
		},
		{
			name:         "explicit priority preserves the existing order",
			query:        "sort=priority",
			wantTotal:    7,
			wantAccounts: []string{"sort_block", "sort_hold_a", "sort_hold_b", "sort_hold_old", "sort_flag_high", "sort_flag_equal", "sort_unscored"},
		},
		{
			name:         "newest first, severity breaks ties, accounts without decisions last",
			query:        "sort=recent",
			wantTotal:    7,
			wantAccounts: []string{"sort_flag_equal", "sort_block", "sort_hold_a", "sort_hold_b", "sort_flag_high", "sort_hold_old", "sort_unscored"},
		},
		{
			name:         "newest is selected before the first page",
			query:        "sort=recent&limit=2",
			wantTotal:    7,
			wantAccounts: []string{"sort_flag_equal", "sort_block"},
		},
		{
			name:         "tied times cross page boundaries without repeats",
			query:        "sort=recent&limit=2&page=2",
			wantTotal:    7,
			wantAccounts: []string{"sort_hold_a", "sort_hold_b"},
		},
		{
			name:         "search and severity apply before sorting and pagination",
			query:        "sort=recent&q=hold_&severity=hold&limit=2&page=2",
			wantTotal:    3,
			wantAccounts: []string{"sort_hold_old"},
		},
		{
			name:         "baseline sorting preserves a reviewed historical score",
			query:        "segment=baseline&sort=recent",
			wantTotal:    2,
			wantAccounts: []string{"baseline_reviewed", "baseline_low"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := decodeResponse[store.Dashboard](t, request(t, f.handler, "GET", "/v1/dashboard?"+tt.query, testAnalystToken, nil))
			if got.Total != tt.wantTotal {
				t.Errorf("matching accounts = %d, want %d", got.Total, tt.wantTotal)
			}
			var accounts []string
			for _, item := range got.Items {
				accounts = append(accounts, item.AccountID)
			}
			if !slices.Equal(accounts, tt.wantAccounts) {
				t.Errorf("account order = %v, want %v", accounts, tt.wantAccounts)
			}
		})
	}
}
func TestDashboardPaginationBeyondTwoHundred(t *testing.T) {
	f := newAPIFixture(t)
	const total = 225
	for i := 0; i < total; i++ {
		dashboardDecision(t, f, dashboardDecisionInput{account: fmt.Sprintf("bulk_%03d", i), key: fmt.Sprintf("bulk_key_%03d", i), action: "allow", at: testNow, review: "none"})
	}
	tests := []struct {
		name                      string
		requestedLimit, wantLimit int
	}{
		{
			name:      "default pages include all 225 accounts",
			wantLimit: 50,
		},
		{
			name:           "oversized limit is capped and the remainder stays accessible",
			requestedLimit: 999,
			wantLimit:      200,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			seen := make(map[string]bool)
			for page := 1; len(seen) < total; page++ {
				query := url.Values{"segment": {"baseline"}, "q": {"bulk_"}, "page": {fmt.Sprint(page)}}
				if tt.requestedLimit != 0 {
					query.Set("limit", fmt.Sprint(tt.requestedLimit))
				}
				got := decodeResponse[store.Dashboard](t, request(t, f.handler, "GET", "/v1/dashboard?"+query.Encode(), testAnalystToken, nil))
				if got.Total != total || got.Limit != tt.wantLimit {
					t.Fatalf("page %d metadata = total:%d limit:%d, want %d/%d", page, got.Total, got.Limit, total, tt.wantLimit)
				}
				wantCount := min(tt.wantLimit, total-len(seen))
				if len(got.Items) != wantCount {
					t.Fatalf("page %d rows = %d, want %d", page, len(got.Items), wantCount)
				}
				for _, item := range got.Items {
					if seen[item.AccountID] {
						t.Fatalf("account %q appears on more than one page", item.AccountID)
					}
					seen[item.AccountID] = true
				}
			}
			if len(seen) != total {
				t.Errorf("distinct accounts = %d, want %d", len(seen), total)
			}
		})
	}
}
func TestDashboardRequestValidation(t *testing.T) {
	handler := (&Server{IngestToken: testIngestToken, AnalystToken: testAnalystToken}).Routes()
	tests := []struct{ name, path string }{
		{
			name: "unknown segment",
			path: "/v1/dashboard?segment=bad",
		},
		{
			name: "unknown severity",
			path: "/v1/dashboard?severity=bad",
		},
		{
			name: "unknown sort order",
			path: "/v1/dashboard?sort=bad",
		},
		{
			name: "unknown metric view",
			path: "/v1/dashboard?view=bad",
		},
		{
			name: "held events cannot use the baseline segment",
			path: "/v1/dashboard?segment=baseline&view=holds",
		},
		{
			name: "suspended keys cannot use the baseline segment",
			path: "/v1/dashboard?segment=baseline&view=keys",
		},
		{
			name: "healthy accounts need the baseline segment",
			path: "/v1/dashboard?view=healthy",
		},
		{
			name: "zero page",
			path: "/v1/dashboard?page=0",
		},
		{
			name: "page beyond supported range",
			path: "/v1/dashboard?page=1000001",
		},
		{
			name: "negative page size",
			path: "/v1/dashboard?limit=-1",
		},
		{
			name: "oversized search",
			path: "/v1/dashboard?q=" + url.QueryEscape(strings.Repeat("a", 201)),
		},
		{
			name: "negative audit cursor",
			path: "/v1/analyst-actions?before_id=-1",
		},
		{
			name: "nonnumeric audit cursor",
			path: "/v1/analyst-actions?before_id=abc",
		},
		{
			name: "malformed audit timestamp",
			path: "/v1/analyst-actions?from=bad",
		},
		{
			name: "reversed audit range",
			path: "/v1/analyst-actions?from=2026-11-01T00:00:00Z&to=2026-10-01T00:00:00Z",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requireStatus(t, request(t, handler, "GET", tt.path, testAnalystToken, nil), 400)
		})
	}
}
func TestAnalystAuditFeed(t *testing.T) {
	f := newAPIFixture(t)
	ctx := context.Background()
	decision := dashboardDecision(t, f, dashboardDecisionInput{account: "audit_account", key: "audit_key", action: "flag", score: 45, at: testNow, review: "open"})
	requireStatus(t, f.action(decision, "confirm_takeover"), 200)
	requireStatus(t, f.post("/v1/keys/audit_key/unblock", map[string]string{"actor": "reviewer", "reason": "key secured"}), 200)
	var newestID int64
	if err := f.server.Store.Pool.QueryRow(ctx, `select max(id) from analyst_actions`).Scan(&newestID); err != nil {
		t.Fatal(err)
	}
	newestAt := testNow.Add(time.Second)
	if _, err := f.server.Store.Pool.Exec(ctx, `update analyst_actions set created_at = case when action='confirm_takeover' then $1::timestamptz else $2::timestamptz end`, testNow, newestAt); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, path  string
		wantActions []string
		wantCursor  bool
	}{
		{
			name:        "newest page includes account from a key-only audit",
			path:        "/v1/analyst-actions?limit=1",
			wantActions: []string{"unblock_key"},
			wantCursor:  true,
		},
		{
			name:        "cursor returns the previous action without duplication",
			path:        fmt.Sprintf("/v1/analyst-actions?limit=1&before_id=%d", newestID),
			wantActions: []string{"confirm_takeover"},
		},
		{
			name:        "full page is ordered by descending ID",
			path:        "/v1/analyst-actions",
			wantActions: []string{"unblock_key", "confirm_takeover"},
		},
		{
			name:        "end time is exclusive",
			path:        "/v1/analyst-actions?to=" + url.QueryEscape(newestAt.Format(time.RFC3339Nano)),
			wantActions: []string{"confirm_takeover"},
		},
		{
			name:        "start time is inclusive",
			path:        "/v1/analyst-actions?from=" + url.QueryEscape(newestAt.Format(time.RFC3339Nano)),
			wantActions: []string{"unblock_key"},
		},
		{
			name: "empty range has an empty page and no cursor",
			path: "/v1/analyst-actions?from=" + url.QueryEscape(testNow.Add(time.Hour).Format(time.RFC3339Nano)),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := decodeResponse[store.AnalystActionPage](t, request(t, f.handler, "GET", tt.path, testAnalystToken, nil))
			if got.Items == nil {
				t.Error("audit items is null, want a JSON array")
			}
			var actions []string
			for i, item := range got.Items {
				actions = append(actions, item.Action)
				if item.AccountID == nil || *item.AccountID != "audit_account" {
					t.Errorf("account = %v, want audit_account", item.AccountID)
				}
				if item.APIKeyID == nil || *item.APIKeyID != "audit_key" {
					t.Errorf("key = %v, want audit_key", item.APIKeyID)
				}
				if i > 0 && item.ID >= got.Items[i-1].ID {
					t.Error("audit IDs are not descending")
				}
			}
			if !slices.Equal(actions, tt.wantActions) {
				t.Errorf("audit actions = %v, want %v", actions, tt.wantActions)
			}
			if (got.NextBeforeID != nil) != tt.wantCursor {
				t.Fatalf("next cursor = %v, want present:%v", got.NextBeforeID, tt.wantCursor)
			}
			if tt.wantCursor && *got.NextBeforeID != newestID {
				t.Errorf("next cursor = %d, want %d", *got.NextBeforeID, newestID)
			}
			stored := f.detail(decision).Decision
			if stored.Score != 45 || stored.Action != "flag" {
				t.Errorf("historical score/action changed: %+v", stored)
			}
		})
	}
}

func TestDashboardKeyAndHoldDetails(t *testing.T) {
	f := newAPIFixture(t)
	trigger := dashboardDecision(t, f, dashboardDecisionInput{account: "trig", key: "key_t", action: "block", score: 85, at: testNow, review: "open"})
	// A later, higher-scoring block on the suspended key outranks the trigger by
	// severity, but it is a consequence of the suspension, not its cause.
	dashboardDecision(t, f, dashboardDecisionInput{account: "trig", key: "key_t", action: "block", score: 95, at: testNow.Add(time.Minute), review: "open"})
	held := dashboardDecision(t, f, dashboardDecisionInput{account: "trig", key: "key_restored", action: "hold", score: 70, at: testNow.Add(2 * time.Minute), review: "open", hold: strp("pending")})
	ctx := context.Background()
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into key_status(api_key_id,account_id,status,reason,decision_id) values('key_t','trig','suspended','auto',$1)`, trigger); err != nil {
		t.Fatal(err)
	}
	// Suspended and then restored: the row stays, now active with reason analyst.
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into key_status(api_key_id,account_id,status,reason) values('key_restored','trig','active','analyst')`); err != nil {
		t.Fatal(err)
	}

	keys := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?view=keys"))
	if len(keys.Items) != 1 || keys.Items[0].DecisionID == nil || *keys.Items[0].DecisionID != trigger {
		t.Fatalf("keys view = %+v, want key_t with its triggering decision %s", keys.Items, trigger)
	}
	if k := keys.Items[0]; k.KeySuspendedBy == nil || *k.KeySuspendedBy != "auto" || k.KeySuspendedAt == nil {
		t.Errorf("key_t suspension = %v at %v, want auto with a time", k.KeySuspendedBy, k.KeySuspendedAt)
	}

	holds := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?view=holds"))
	if len(holds.Items) != 1 || *holds.Items[0].DecisionID != held {
		t.Fatalf("holds view = %+v, want the held decision %s", holds.Items, held)
	}
	h := holds.Items[0]
	if h.HoldExpiresAt == nil || !h.HoldExpiresAt.Equal(testNow.Add(2*time.Minute+24*time.Hour)) {
		t.Errorf("hold expires at %v, want 24 h after the held event", h.HoldExpiresAt)
	}
	if h.EventType == nil || *h.EventType != "email.send" {
		t.Errorf("held row event type = %v, want email.send", h.EventType)
	}
	if h.KeyStatus == nil || *h.KeyStatus != "active" || h.KeySuspendedBy != nil || h.KeySuspendedAt != nil {
		t.Errorf("restored key = status %v, suspended by %v at %v; want active with no suspension details", h.KeyStatus, h.KeySuspendedBy, h.KeySuspendedAt)
	}
}

// QA found blocked accounts represented by a later key_suspended rejection
// (evidence "key suspended", Review opening the wrong decision) and a search
// that matched JSON keys but not the text on the page.
func TestDashboardFollowOnRejectionsAndSearch(t *testing.T) {
	f := newAPIFixture(t)
	trigger := dashboardDecision(t, f, dashboardDecisionInput{account: "blocked", key: "key_blk", action: "block", score: 90, at: testNow, review: "open"})
	// Same score, later, open: before the fix it won the tie on recency.
	dashboardDecision(t, f, dashboardDecisionInput{account: "blocked", key: "key_blk", action: "block", score: 90, at: testNow.Add(time.Minute), review: "open", reason: strp("key_suspended")})

	got := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard"))
	if len(got.Items) != 1 || got.Items[0].DecisionID == nil || *got.Items[0].DecisionID != trigger {
		t.Fatalf("queue row = %+v, want the scored block %s", got.Items, trigger)
	}
	if got.Items[0].PrimaryDriver != "new_asn" {
		t.Errorf("primary driver = %q, want the top hit new_asn", got.Items[0].PrimaryDriver)
	}

	for _, tt := range []struct {
		q    string
		want int
	}{
		{"new asn", 1},            // as displayed
		{"new_asn", 1},            // as stored
		{"AS14061 first seen", 1}, // the evidence line
		{"points", 0},             // a JSON key, never shown
		{"category", 0},           // a JSON key, never shown
	} {
		if got := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?q="+url.QueryEscape(tt.q))); got.Total != tt.want {
			t.Errorf("search %q matched %d accounts, want %d", tt.q, got.Total, tt.want)
		}
	}

	accounts := decodeResponse[[]store.AccountSummary](t, f.get("/v1/accounts?q="+url.QueryEscape("%")))
	if len(accounts) != 0 {
		t.Errorf("account search for %% matched %d accounts, want 0 (a literal, not a wildcard)", len(accounts))
	}
}

// After an analyst confirms the triggering block it is resolved, but the attacker's
// later sends keep arriving as open key_suspended rejections. Those must still not
// represent the account or the key; a row that is itself a rejection says so.
func TestDashboardRejectionsAfterResolution(t *testing.T) {
	f := newAPIFixture(t)
	trigger := dashboardDecision(t, f, dashboardDecisionInput{account: "confirmed", key: "key_c1", action: "block", score: 90, at: testNow, review: "resolved", label: strp("takeover")})
	dashboardDecision(t, f, dashboardDecisionInput{account: "confirmed", key: "key_c1", action: "block", score: 95, at: testNow.Add(time.Minute), review: "open", reason: strp("key_suspended")})
	// Only a rejection on this account: it is shown, labelled as one.
	dashboardDecision(t, f, dashboardDecisionInput{account: "only_rejected", key: "key_r1", action: "block", score: 40, at: testNow, review: "open", reason: strp("key_suspended")})
	// Owner suspension (no triggering decision): the key row falls back to the
	// key's ranking, which must also put rejections last.
	scored := dashboardDecision(t, f, dashboardDecisionInput{account: "owner_susp", key: "key_o1", action: "block", score: 60, at: testNow, review: "open"})
	dashboardDecision(t, f, dashboardDecisionInput{account: "owner_susp", key: "key_o1", action: "block", score: 80, at: testNow.Add(time.Minute), review: "open", reason: strp("key_suspended")})
	ctx := context.Background()
	for _, k := range [][2]string{{"key_c1", "confirmed"}, {"key_r1", "only_rejected"}, {"key_o1", "owner_susp"}} {
		reason := "auto"
		if k[0] == "key_o1" {
			reason = "owner"
		}
		if _, err := f.server.Store.Pool.Exec(ctx, `insert into key_status(api_key_id,account_id,status,reason) values($1,$2,'suspended',$3)`, k[0], k[1], reason); err != nil {
			t.Fatal(err)
		}
	}

	rows := map[string]store.DashboardAccount{}
	for _, item := range decodeResponse[store.Dashboard](t, f.get("/v1/dashboard")).Items {
		rows[item.AccountID] = item
	}
	if r := rows["confirmed"]; r.DecisionID == nil || *r.DecisionID != trigger || r.PrimaryDriver != "new_asn" {
		t.Errorf("confirmed account row = %v / %q, want the resolved trigger %s driven by new_asn", r.DecisionID, r.PrimaryDriver, trigger)
	}
	if r := rows["only_rejected"]; r.PrimaryDriver != "key_suspended" {
		t.Errorf("rejection-only row driver = %q, want key_suspended rather than its hits", r.PrimaryDriver)
	}
	if got := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?q="+url.QueryEscape("key suspended"))); got.Total != 1 {
		t.Errorf(`search "key suspended" matched %d accounts, want 1`, got.Total)
	}

	keys := map[string]store.DashboardAccount{}
	for _, item := range decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?view=keys")).Items {
		keys[*item.APIKeyID] = item
	}
	if k := keys["key_o1"]; k.DecisionID == nil || *k.DecisionID != scored {
		t.Errorf("owner-suspended key row = %v, want the scored block %s, not the later rejection", k.DecisionID, scored)
	}
}
