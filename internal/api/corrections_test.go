package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/engine"
	"github.com/poojadesai14/resend-ato/internal/store"
)

// An analyst can re-lock any key directly: the way back from a wrong legitimate call.
func TestSuspendKey(t *testing.T) {
	f := newAPIFixture(t)
	ctx := context.Background()
	db := f.server.Store.Pool
	// A key never suspended before, with a pending hold.
	held := dashboardDecision(t, f, dashboardDecisionInput{account: "acct", key: "key_live", action: "hold", score: 70, at: testNow, review: "open", hold: strp("pending")})

	got := decodeResponse[map[string]any](t, f.post("/v1/keys/key_live/suspend", map[string]any{"actor": "reviewer", "reason": "resolved by mistake"}))
	if got["status"] != "suspended" || got["holds_dropped"] != float64(1) {
		t.Fatalf("suspend = %v, want suspended with 1 hold dropped", got)
	}
	var status, reason, hold string
	var decision *string
	if err := db.QueryRow(ctx, `select status, reason, decision_id::text from key_status where api_key_id = 'key_live'`).Scan(&status, &reason, &decision); err != nil {
		t.Fatal(err)
	}
	if status != "suspended" || reason != "analyst" || decision != nil {
		t.Errorf("key_live = %s/%s/%v, want suspended by the analyst with no decision", status, reason, decision)
	}
	if err := db.QueryRow(ctx, `select hold_status from decisions where decision_id = $1`, held).Scan(&hold); err != nil || hold != "dropped" {
		t.Errorf("hold = %s (%v), want dropped", hold, err)
	}
	var audited int
	if err := db.QueryRow(ctx, `select count(*) from analyst_actions where action = 'suspend_key' and api_key_id = 'key_live' and actor = 'reviewer'`).Scan(&audited); err != nil || audited != 1 {
		t.Errorf("suspend_key audit rows = %d (%v), want 1", audited, err)
	}

	requireStatus(t, f.post("/v1/keys/key_live/suspend", map[string]any{"actor": "r", "reason": "x"}), http.StatusConflict)
	requireStatus(t, f.post("/v1/keys/key_nobody/suspend", map[string]any{"actor": "r", "reason": "x"}), http.StatusNotFound)
	requireStatus(t, f.post("/v1/keys/key_live/suspend", map[string]any{"actor": "r"}), http.StatusBadRequest)
	// The ordinary restore still works on an analyst's suspension.
	requireStatus(t, f.post("/v1/keys/key_live/unblock", map[string]any{"actor": "r", "reason": "owner rotated"}), http.StatusOK)
}

// A takeover resolved as legitimate by mistake can be corrected: labels flip to
// takeover, the baseline forgets the attacker's network and domain, and the key is
// suspended again (QA: sim_1101_0747_011).
func TestCorrectToTakeover(t *testing.T) {
	f := newAPIFixture(t)
	ctx := context.Background()
	db := f.server.Store.Pool
	scalar := func(sql string, args ...any) string {
		t.Helper()
		var v string
		if err := db.QueryRow(ctx, sql, args...).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	baseline := func() string {
		return scalar(`select events_seen || ' ' || coalesce(key_asns->'key_w'->>'14061','-') || ' ' || coalesce(known_domains->>'docs-share-portal.com','-') from profiles where account_id = 'wrong'`)
	}

	// The attack: a block with a young phishing domain that auto-suspended the key.
	block := dashboardDecision(t, f, dashboardDecisionInput{account: "wrong", key: "key_w", action: "block", score: 90, at: testNow, review: "open"})
	if _, err := db.Exec(ctx, `update events set link_domains = '{docs-share-portal.com}' where event_id = (select event_id from decisions where decision_id = $1)`, block); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `update decisions set hits = '[{"name":"young_domain","category":"content","points":20,"detail":"docs-share-portal.com registered 6 days ago"}]' where decision_id = $1`, block); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `insert into key_status(api_key_id,account_id,status,reason,decision_id) values('key_w','wrong','suspended','auto',$1)`, block); err != nil {
		t.Fatal(err)
	}

	// Guard rail: "legitimate" over a young domain needs the account ID typed.
	open := decodeResponse[struct {
		Open store.OpenCounts `json:"open"`
	}](t, f.get("/v1/accounts/wrong/profile")).Open
	if len(open.Warnings) != 1 || open.Warnings[0].Signal != "young_domain" {
		t.Fatalf("warnings = %+v, want young_domain", open.Warnings)
	}
	body := map[string]any{"decision_ids": []string{block}, "outcome": "legitimate", "restore_keys": true, "actor": "reviewer", "reason": "looks fine"}
	requireStatus(t, f.post("/v1/accounts/wrong/resolve", body), http.StatusConflict)
	body["confirm"] = "not-this-account"
	requireStatus(t, f.post("/v1/accounts/wrong/resolve", body), http.StatusConflict)
	if l := scalar(`select coalesce(label,'') from decisions where decision_id = $1`, block); l != "" {
		t.Fatalf("an unconfirmed resolution labelled the block %q", l)
	}
	before := baseline()
	body["confirm"] = "wrong"
	requireStatus(t, f.post("/v1/accounts/wrong/resolve", body), http.StatusOK)
	if got := baseline(); got != "101 1 1" {
		t.Fatalf("baseline after the wrong call = %q, want the attacker learned (101 1 1); before %q", got, before)
	}

	// The profile lists what can be corrected.
	listed := decodeResponse[struct {
		Legitimate []store.ReviewedDecision `json:"legitimate_decisions"`
	}](t, f.get("/v1/accounts/wrong/profile")).Legitimate
	if len(listed) != 1 || listed[0].DecisionID != block || listed[0].Driver != "young_domain" {
		t.Fatalf("legitimate decisions = %+v, want the block", listed)
	}

	// The correction.
	got := decodeResponse[engine.Correction](t, f.post("/v1/accounts/wrong/correct", map[string]any{"decision_ids": []string{block, block}, "actor": "reviewer", "reason": "phishing domain"}))
	if got.Corrected != 1 || !slices.Equal(got.KeysSuspended, []string{"key_w"}) {
		t.Fatalf("correct = %+v, want 1 corrected, key_w suspended", got)
	}
	if l := scalar(`select label || '/' || review_status from decisions where decision_id = $1`, block); l != "takeover/resolved" {
		t.Errorf("block = %s, want takeover/resolved", l)
	}
	if k := scalar(`select status || '/' || reason || '/' || decision_id from key_status where api_key_id = 'key_w'`); k != "suspended/analyst/"+block {
		t.Errorf("key_w = %s, want suspended by the analyst for the block", k)
	}
	if got := baseline(); got != "100 - -" {
		t.Errorf("baseline after correction = %q, want the attacker's network and domain forgotten (100 - -)", got)
	}
	if n := scalar(`select count(*)::text from analyst_actions where action = 'correct_to_takeover' and decision_id = $1 and api_key_id = 'key_w' and reason = 'correction: phishing domain'`, block); n != "1" {
		t.Errorf("correct_to_takeover audit rows = %s, want 1", n)
	}
	// The account now has a takeover: nothing offers to restore its key.
	if c := decodeResponse[struct {
		Open store.OpenCounts `json:"open"`
	}](t, f.get("/v1/accounts/wrong/profile")).Open; c.RestorableKeys != 0 {
		t.Errorf("restorable keys after correction = %d, want 0", c.RestorableKeys)
	}

	// Only decisions on this account that are marked legitimate can be corrected.
	other := dashboardDecision(t, f, dashboardDecisionInput{account: "else", key: "key_e", action: "block", score: 90, at: testNow.Add(time.Hour), review: "resolved", label: strp("legitimate")})
	correct := func(account string, ids []string) *httptest.ResponseRecorder {
		return f.post("/v1/accounts/"+account+"/correct", map[string]any{"decision_ids": ids, "actor": "r", "reason": "x"})
	}
	requireStatus(t, correct("wrong", []string{block}), http.StatusConflict)          // already takeover
	requireStatus(t, correct("wrong", []string{other}), http.StatusConflict)          // another account's
	requireStatus(t, correct("wrong", []string{"not-a-uuid"}), http.StatusBadRequest) // malformed
	requireStatus(t, correct("wrong", nil), http.StatusBadRequest)
	if l := scalar(`select label from decisions where decision_id = $1`, other); l != "legitimate" {
		t.Errorf("another account's decision was relabelled %s", l)
	}
}
