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
	label, hold          *string
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
	err := f.server.Store.Pool.QueryRow(ctx, `insert into decisions(event_id,account_id,api_key_id,occurred_at,action,enforced,score,hits,config_version,review_status,label,hold_status)
 values($1,$2,$3,$4,$5,true,$6,'[{"name":"new_asn","category":"network","points":30,"detail":"AS14061 first seen"}]','test',$7,$8,$9) returning decision_id::text`, eventID, input.account, input.key, input.at, input.action, input.score, input.review, input.label, input.hold).Scan(&id)
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
			name:       "high severity includes score eighty",
			query:      "severity=high",
			wantTotal:  2,
			wantScores: []int{85, 80},
		},
		{
			name:       "medium severity includes forty through seventy-nine",
			query:      "severity=medium",
			wantTotal:  2,
			wantScores: []int{79, 40},
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
