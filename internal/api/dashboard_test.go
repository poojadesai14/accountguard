package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/store"
)

func dashboardDecision(t *testing.T, f *apiFixture, account, key, action string, score int, at time.Time, review string, label, hold *string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into profiles(account_id,first_seen_at,events_seen,active_hours) values($1,$2,100,100) on conflict do nothing`, account, at); err != nil {
		t.Fatal(err)
	}
	eventID := fmt.Sprintf("%s_%s_%d", account, action, at.UnixNano())
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into events(event_id,type,occurred_at,account_id,api_key_id,source,ip,asn,asn_org) values($1,'email.send',$2,$3,$4,'api','203.0.113.9',14061,'DigitalOcean')`, eventID, at, account, key); err != nil {
		t.Fatal(err)
	}
	var id string
	err := f.server.Store.Pool.QueryRow(ctx, `insert into decisions(event_id,account_id,api_key_id,occurred_at,action,enforced,score,hits,config_version,review_status,label,hold_status)
 values($1,$2,$3,$4,$5,true,$6,'[{"name":"new_asn","category":"network","points":30,"detail":"AS14061 first seen"}]','test',$7,$8,$9) returning decision_id::text`, eventID, account, key, at, action, score, review, label, hold).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func strp(v string) *string { return &v }
func TestDashboardClassificationAndFilters(t *testing.T) {
	f := newAPIFixture(t)
	ctx := context.Background()
	dashboardDecision(t, f, "multi", "key_a", "flag", 45, testNow, "open", nil, nil)
	chosen := dashboardDecision(t, f, "multi", "key_a", "block", 85, testNow.Add(time.Minute), "open", nil, nil)
	dashboardDecision(t, f, "multi", "key_b", "hold", 60, testNow.Add(2*time.Minute), "open", nil, strp("pending"))
	dashboardDecision(t, f, "multi", "key_b", "allow", 0, testNow.Add(3*time.Minute), "none", nil, nil)
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into key_status(api_key_id,account_id,status,reason) values('key_a','multi','suspended','analyst'),('key_c','multi','suspended','owner')`); err != nil {
		t.Fatal(err)
	}
	approved := dashboardDecision(t, f, "approved", "key_good", "hold", 75, testNow, "resolved", strp("legitimate"), strp("released"))
	dashboardDecision(t, f, "learning", "key_learning", "allow", 0, testNow, "none", nil, nil)
	if _, err := f.server.Store.Pool.Exec(ctx, `update profiles set events_seen=1,active_hours=1 where account_id='learning'`); err != nil {
		t.Fatal(err)
	}
	for _, score := range []int{39, 40, 79, 80} {
		dashboardDecision(t, f, fmt.Sprintf("edge_%d", score), fmt.Sprintf("key_%d", score), "flag", score, testNow, "open", nil, nil)
	}
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into profiles(account_id,first_seen_at) values('unscored',$1)`, testNow); err != nil {
		t.Fatal(err)
	}
	result := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard"))
	if result.Total != 5 || result.Metrics.AttentionAccounts != 5 || result.Metrics.PendingQuarantines != 1 || result.Metrics.SuspendedKeys != 2 || result.Metrics.HealthyBaselines != 1 {
		t.Fatalf("wrong aggregates: %+v", result)
	}
	if result.EngineMode != f.server.Config.Mode || result.GeneratedAt.IsZero() {
		t.Fatal("missing mode or snapshot time")
	}
	multi := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?q=multi"))
	if len(multi.Items) != 1 || *multi.Items[0].DecisionID != chosen || *multi.Items[0].Score != 85 || multi.Items[0].OpenReviews != 3 || multi.Items[0].SuspendedKeys != 2 || *multi.Items[0].KeyStatus != "suspended" {
		t.Fatalf("wrong representative: %+v", multi.Items)
	}
	baseline := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?segment=baseline"))
	if baseline.Total != 2 {
		t.Fatalf("baseline count %d", baseline.Total)
	}
	for _, item := range baseline.Items {
		if item.AccountID == "approved" && (*item.DecisionID != approved || *item.Action != "hold" || *item.Score != 75 || !item.BaselineReady) {
			t.Fatalf("approval rewrote history: %+v", item)
		}
		if item.AccountID == "learning" && item.BaselineReady {
			t.Fatal("cold account marked ready")
		}
	}
	for _, tc := range []struct {
		q     string
		count int
	}{{"severity=high", 2}, {"severity=medium", 2}, {"q=key_a", 1}, {"q=203.0.113.9", 5}, {"q=AS14061", 5}, {"q=" + url.QueryEscape("new asn"), 5}, {"q=%25", 0}} {
		got := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?"+tc.q))
		if got.Total != tc.count {
			t.Errorf("%s: %d want %d", tc.q, got.Total, tc.count)
		}
	}
	empty := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?page=99"))
	if empty.Items == nil || len(empty.Items) != 0 || empty.Total != 5 {
		t.Fatal("empty page lost matching total")
	}
}
func TestDashboardPaginationBeyondTwoHundred(t *testing.T) {
	f := newAPIFixture(t)
	for i := 0; i < 225; i++ {
		dashboardDecision(t, f, fmt.Sprintf("bulk_%03d", i), fmt.Sprintf("bulk_key_%03d", i), "allow", 0, testNow, "none", nil, nil)
	}
	seen := map[string]bool{}
	for page := 1; page <= 5; page++ {
		result := decodeResponse[store.Dashboard](t, f.get(fmt.Sprintf("/v1/dashboard?segment=baseline&q=bulk_&page=%d", page)))
		if result.Total != 225 || result.Limit != 50 {
			t.Fatalf("pagination metadata: %+v", result)
		}
		for _, item := range result.Items {
			if seen[item.AccountID] {
				t.Fatal("duplicate page row")
			}
			seen[item.AccountID] = true
		}
	}
	if len(seen) != 225 {
		t.Fatalf("lost accounts: %d", len(seen))
	}
	capped := decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?segment=baseline&limit=999"))
	if capped.Limit != 200 || len(capped.Items) != 200 {
		t.Fatal("limit not capped")
	}
}
func TestDashboardAuthValidationAndAuditFeed(t *testing.T) {
	f := newAPIFixture(t)
	for _, path := range []string{"/v1/dashboard", "/v1/analyst-actions"} {
		for _, token := range []string{"", testIngestToken} {
			requireStatus(t, request(t, f.handler, http.MethodGet, path, token, nil), 401)
		}
	}
	for _, path := range []string{"/v1/dashboard?segment=bad", "/v1/dashboard?severity=bad", "/v1/dashboard?page=0", "/v1/dashboard?page=1000001", "/v1/dashboard?limit=-1", "/v1/dashboard?q=" + url.QueryEscape(strings.Repeat("a", 201)), "/v1/analyst-actions?before_id=-1", "/v1/analyst-actions?before_id=abc", "/v1/analyst-actions?from=bad", "/v1/analyst-actions?from=2026-11-01T00:00:00Z&to=2026-10-01T00:00:00Z"} {
		requireStatus(t, f.get(path), 400)
	}
	id := dashboardDecision(t, f, "audit_account", "audit_key", "flag", 45, testNow, "open", nil, nil)
	requireStatus(t, f.action(id, "confirm_takeover"), 200)
	requireStatus(t, f.post("/v1/keys/audit_key/unblock", map[string]string{"actor": "reviewer", "reason": "key secured"}), 200)
	first := decodeResponse[store.AnalystActionPage](t, f.get("/v1/analyst-actions?limit=1"))
	if len(first.Items) != 1 || first.NextBeforeID == nil || first.Items[0].Action != "unblock_key" || first.Items[0].AccountID == nil || *first.Items[0].AccountID != "audit_account" {
		t.Fatalf("audit join/cursor: %+v", first)
	}
	second := decodeResponse[store.AnalystActionPage](t, f.get(fmt.Sprintf("/v1/analyst-actions?limit=1&before_id=%d", *first.NextBeforeID)))
	if len(second.Items) != 1 || second.NextBeforeID != nil || second.Items[0].Action != "confirm_takeover" || second.Items[0].ID >= first.Items[0].ID {
		t.Fatal("audit pagination skipped or duplicated an action")
	}
	until := first.Items[0].CreatedAt.UTC().Format(time.RFC3339Nano)
	bounded := decodeResponse[store.AnalystActionPage](t, f.get("/v1/analyst-actions?to="+url.QueryEscape(until)))
	if len(bounded.Items) > 0 && bounded.Items[0].ID == first.Items[0].ID {
		t.Fatal("audit end is not exclusive")
	}
	d := f.detail(id)
	if d.Decision.Score != 45 || d.Decision.Action != "flag" {
		t.Fatal("analyst action rewrote historical score/action")
	}
}
