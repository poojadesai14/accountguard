package api

import (
	"context"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/engine"
	"github.com/poojadesai14/resend-ato/internal/store"
)

func TestResolveAccount(t *testing.T) {
	f := newAPIFixture(t)
	ctx := context.Background()
	db := f.server.Store.Pool
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	scalar := func(sql string, args ...any) string {
		t.Helper()
		var v string
		if err := db.QueryRow(ctx, sql, args...).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	suspend := func(key, account, reason, decision string) {
		t.Helper()
		exec(`insert into key_status(api_key_id,account_id,status,reason,decision_id) values($1,$2,'suspended',$3,$4)
			on conflict (api_key_id) do update set status='suspended', reason=excluded.reason, decision_id=excluded.decision_id`, key, account, reason, decision)
	}
	keyStatus := func(key string) string { return scalar(`select status from key_status where api_key_id = $1`, key) }
	resolve := func(account string, body map[string]any) *engine.AccountResolution {
		t.Helper()
		got := decodeResponse[engine.AccountResolution](t, f.post("/v1/accounts/"+account+"/resolve", body))
		return &got
	}
	openCounts := func(account string) store.OpenCounts {
		t.Helper()
		return decodeResponse[struct {
			Open store.OpenCounts `json:"open"`
		}](t, f.get("/v1/accounts/"+account+"/profile")).Open
	}
	inQueue := func(account string) bool {
		for _, item := range decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?q="+account)).Items {
			if item.AccountID == account {
				return true
			}
		}
		return false
	}
	decision := func(id string) string {
		return scalar(`select coalesce(label,'') || '/' || review_status || '/' || coalesce(hold_status,'') from decisions where decision_id = $1`, id)
	}
	audits := func(action, key, reason string) string {
		return scalar(`select count(*)::text from analyst_actions where action = $1 and coalesce(api_key_id,'') = $2 and reason = $3`, action, key, reason)
	}

	// A false positive: a held send, then the block that auto-suspended the key.
	hold := dashboardDecision(t, f, dashboardDecisionInput{account: "fp", key: "key_fp", action: "hold", score: 70, at: testNow, review: "open", hold: strp("pending")})
	block := dashboardDecision(t, f, dashboardDecisionInput{account: "fp", key: "key_fp", action: "block", score: 90, at: testNow.Add(time.Minute), review: "open"})
	suspend("key_fp", "fp", "auto", block)
	// Two suspensions on the same account that a legitimate resolution must not touch:
	// a key the owner reported stolen, and one whose suspending review was closed
	// earlier without restoring it (the per-key restore is the step for that).
	stolen := dashboardDecision(t, f, dashboardDecisionInput{account: "fp", key: "key_stolen", action: "hold", score: 75, at: testNow.Add(-time.Hour), review: "resolved", label: strp("takeover"), hold: strp("dropped")})
	suspend("key_stolen", "fp", "owner", stolen)
	closed := dashboardDecision(t, f, dashboardDecisionInput{account: "fp", key: "key_old", action: "block", score: 85, at: testNow.Add(-2 * time.Hour), review: "resolved", label: strp("legitimate")})
	suspend("key_old", "fp", "auto", closed)

	// The profile tells the UI what a resolution would close, and which reviews it saw.
	open := openCounts("fp")
	if open.Reviews != 2 || open.PendingHolds != 1 || open.SuspendedKeys != 3 || open.RestorableKeys != 1 ||
		!slices.Equal(open.DecisionIDs, []string{hold, block}) {
		t.Fatalf("open counts = %+v, want 2 reviews [hold block], 1 held, 3 suspended, 1 restorable", open)
	}

	// Reviews the analyst didn't see: nothing changes.
	requireStatus(t, f.post("/v1/accounts/fp/resolve", map[string]any{"decision_ids": []string{hold}, "outcome": "legitimate", "restore_keys": true, "actor": "r", "reason": "x"}), http.StatusConflict)
	if got := decision(block); got != "/open/" {
		t.Fatalf("stale resolution changed the block: %s", got)
	}

	// Legitimate with restore: both reviews close, the hold is released, the baseline
	// learns the stopped events' network, and only the key those reviews suspended returns.
	got := resolve("fp", map[string]any{"decision_ids": open.DecisionIDs, "outcome": "legitimate", "restore_keys": true, "actor": "reviewer", "reason": "owner confirmed"})
	if got.Resolved != 2 || got.HoldsReleased != 1 || !slices.Equal(got.KeysRestored, []string{"key_fp"}) {
		t.Fatalf("legitimate = %+v, want 2 resolved, 1 hold released, key_fp restored", got)
	}
	if d := decision(hold); d != "legitimate/resolved/released" {
		t.Errorf("hold = %s, want legitimate/resolved/released", d)
	}
	if d := decision(block); d != "legitimate/resolved/" {
		t.Errorf("block = %s, want legitimate/resolved", d)
	}
	if s := keyStatus("key_fp"); s != "active" {
		t.Errorf("key_fp = %s, want active", s)
	}
	for _, key := range []string{"key_stolen", "key_old"} {
		if s := keyStatus(key); s != "suspended" {
			t.Errorf("%s = %s, a legitimate resolution restored a key it didn't suspend", key, s)
		}
	}
	if n := scalar(`select coalesce(key_asns->'key_fp'->>'14061','0') from profiles where account_id = 'fp'`); n != "2" {
		t.Errorf("baseline saw AS14061 on key_fp %s times, want 2 (one per resolved event)", n)
	}
	if n := audits("mark_legitimate", "key_fp", "account resolution: owner confirmed"); n != "2" {
		t.Errorf("mark_legitimate audit rows = %s, want 2", n)
	}
	if n := audits("unblock_key", "key_fp", "account resolution: owner confirmed"); n != "1" {
		t.Errorf("unblock_key audit rows = %s, want 1", n)
	}
	if !inQueue("fp") {
		t.Error("account left the queue while a stolen key is still suspended")
	}

	// Without restore the key stays suspended; with nothing else, a restored account leaves the queue.
	keep := dashboardDecision(t, f, dashboardDecisionInput{account: "keep", key: "key_keep", action: "block", score: 90, at: testNow, review: "open"})
	suspend("key_keep", "keep", "auto", keep)
	if got := resolve("keep", map[string]any{"decision_ids": []string{keep}, "outcome": "legitimate", "actor": "reviewer", "reason": "later"}); got.Resolved != 1 || len(got.KeysRestored) != 0 {
		t.Fatalf("legitimate without restore = %+v", got)
	}
	if s := keyStatus("key_keep"); s != "suspended" || !inQueue("keep") {
		t.Errorf("key_keep = %s, in queue %v; want suspended and queued", s, inQueue("keep"))
	}
	clean := dashboardDecision(t, f, dashboardDecisionInput{account: "clean", key: "key_clean", action: "block", score: 90, at: testNow, review: "open"})
	suspend("key_clean", "clean", "auto", clean)
	resolve("clean", map[string]any{"decision_ids": []string{clean}, "outcome": "legitimate", "restore_keys": true, "actor": "reviewer", "reason": "rotated"})
	if inQueue("clean") {
		t.Error("account is still in the queue after its reviews closed and its key was restored")
	}
	found := false
	for _, item := range decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?segment=baseline&q=clean")).Items {
		found = found || item.AccountID == "clean"
	}
	if !found {
		t.Error("resolved account is missing from the legitimate baselines")
	}

	// Takeover: holds dropped, the key they were sent with suspended by the analyst.
	tk := dashboardDecision(t, f, dashboardDecisionInput{account: "ato", key: "key_ato", action: "hold", score: 75, at: testNow, review: "open", hold: strp("pending")})
	got = resolve("ato", map[string]any{"decision_ids": []string{tk}, "outcome": "takeover", "actor": "reviewer", "reason": "confirmed with owner"})
	if got.Resolved != 1 || got.HoldsDropped != 1 || !slices.Equal(got.KeysSuspended, []string{"key_ato"}) {
		t.Fatalf("takeover = %+v, want 1 resolved, 1 hold dropped, key_ato suspended", got)
	}
	if d := decision(tk); d != "takeover/resolved/dropped" {
		t.Errorf("takeover decision = %s", d)
	}
	if s := scalar(`select status || '/' || reason || '/' || decision_id from key_status where api_key_id = 'key_ato'`); s != "suspended/analyst/"+tk {
		t.Errorf("key_ato = %s, want suspended by the analyst for %s", s, tk)
	}
	if n := audits("confirm_takeover", "key_ato", "account resolution: confirmed with owner"); n != "1" {
		t.Errorf("confirm_takeover audit rows = %s, want 1", n)
	}

	// A key with a confirmed takeover behind it is never restored, even if a later
	// open review is what suspended it last.
	later := dashboardDecision(t, f, dashboardDecisionInput{account: "ato", key: "key_ato", action: "block", score: 90, at: testNow.Add(time.Hour), review: "open"})
	suspend("key_ato", "ato", "auto", later)
	if c := openCounts("ato"); c.RestorableKeys != 0 {
		t.Errorf("restorable keys after a takeover = %d, want 0", c.RestorableKeys)
	}
	got = resolve("ato", map[string]any{"decision_ids": []string{later}, "outcome": "legitimate", "restore_keys": true, "actor": "reviewer", "reason": "x"})
	if len(got.KeysRestored) != 0 || keyStatus("key_ato") != "suspended" {
		t.Errorf("restored a key with a confirmed takeover: %+v", got)
	}

	// Nothing left, bad combinations, and missing fields are refused.
	for _, outcome := range []string{"legitimate", "takeover"} {
		requireStatus(t, f.post("/v1/accounts/ato/resolve", map[string]any{"decision_ids": []string{later}, "outcome": outcome, "restore_keys": outcome == "legitimate", "actor": "r", "reason": "x"}), http.StatusConflict)
	}
	requireStatus(t, f.post("/v1/accounts/fp/resolve", map[string]any{"outcome": "legitimate", "actor": "r", "reason": "x"}), http.StatusBadRequest)
	requireStatus(t, f.post("/v1/accounts/fp/resolve", map[string]any{"decision_ids": []string{hold}, "outcome": "takeover", "restore_keys": true, "actor": "r", "reason": "x"}), http.StatusBadRequest)
	requireStatus(t, f.post("/v1/accounts/fp/resolve", map[string]any{"decision_ids": []string{hold}, "outcome": "legitimate", "actor": "r"}), http.StatusBadRequest)
	requireStatus(t, f.post("/v1/accounts/fp/resolve", map[string]any{"decision_ids": []string{hold}, "outcome": "maybe", "actor": "r", "reason": "x"}), http.StatusBadRequest)
}
