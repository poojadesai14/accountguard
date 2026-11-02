package api

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/engine"
	"github.com/poojadesai14/resend-ato/internal/store"
)

func TestResolveAccount(t *testing.T) {
	f := newAPIFixture(t)
	suspend := func(key, account, reason, decision string) {
		t.Helper()
		execSQL(t, f, `insert into key_status(api_key_id,account_id,status,reason,decision_id) values($1,$2,'suspended',$3,$4)
			on conflict (api_key_id) do update set status='suspended', reason=excluded.reason, decision_id=excluded.decision_id`, key, account, reason, decision)
	}
	keyStatus := func(t *testing.T, key string) string {
		return queryText(t, f, `select status from key_status where api_key_id = $1`, key)
	}
	decision := func(t *testing.T, id string) string {
		return queryText(t, f, `select coalesce(label,'') || '/' || review_status || '/' || coalesce(hold_status,'') from decisions where decision_id = $1`, id)
	}
	audits := func(t *testing.T, action, key, reason string) string {
		return queryText(t, f, `select count(*)::text from analyst_actions where action = $1 and coalesce(api_key_id,'') = $2 and reason = $3`, action, key, reason)
	}
	inSegment := func(t *testing.T, query, account string) bool {
		for _, item := range decodeResponse[store.Dashboard](t, f.get("/v1/dashboard?"+query+"q="+account)).Items {
			if item.AccountID == account {
				return true
			}
		}
		return false
	}
	resolution := func(t *testing.T, w *httptest.ResponseRecorder) engine.AccountResolution {
		return decodeResponse[engine.AccountResolution](t, w)
	}
	openOf := func(t *testing.T, w *httptest.ResponseRecorder) store.OpenCounts {
		return decodeResponse[struct {
			Open store.OpenCounts `json:"open"`
		}](t, w).Open
	}
	resolve := func(ids []string, outcome string, restore bool, reason string) map[string]any {
		return map[string]any{"decision_ids": ids, "outcome": outcome, "restore_keys": restore, "actor": "reviewer", "reason": reason}
	}

	// fp: a false positive. A held send, then the block that auto-suspended its key.
	hold := dashboardDecision(t, f, dashboardDecisionInput{account: "fp", key: "key_fp", action: "hold", score: 70, at: testNow, review: "open", hold: strp("pending")})
	block := dashboardDecision(t, f, dashboardDecisionInput{account: "fp", key: "key_fp", action: "block", score: 90, at: testNow.Add(time.Minute), review: "open"})
	suspend("key_fp", "fp", "auto", block)
	// A key an analyst suspended by hand must never come back this way; a key whose
	// suspending block was already marked legitimate (without a restore) may: the
	// analyst judged that block, and it is the step left (QA: sim_1101_0747_069).
	execSQL(t, f, `insert into key_status(api_key_id,account_id,status,reason) values('key_manual','fp','suspended','analyst')`)
	closed := dashboardDecision(t, f, dashboardDecisionInput{account: "fp", key: "key_old", action: "block", score: 85, at: testNow.Add(-2 * time.Hour), review: "resolved", label: strp("legitimate")})
	suspend("key_old", "fp", "auto", closed)
	// Another account's key in the same state: resolving fp must not touch it.
	other := dashboardDecision(t, f, dashboardDecisionInput{account: "other", key: "key_other", action: "block", score: 90, at: testNow, review: "resolved", label: strp("legitimate")})
	suspend("key_other", "other", "auto", other)
	// keep: resolved without restore. clean: resolved with restore, nothing else open.
	keep := dashboardDecision(t, f, dashboardDecisionInput{account: "keep", key: "key_keep", action: "block", score: 90, at: testNow, review: "open"})
	suspend("key_keep", "keep", "auto", keep)
	clean := dashboardDecision(t, f, dashboardDecisionInput{account: "clean", key: "key_clean", action: "block", score: 90, at: testNow, review: "open"})
	suspend("key_clean", "clean", "auto", clean)
	// ato: a takeover with a pending hold. A later block arrives after it is resolved.
	tk := dashboardDecision(t, f, dashboardDecisionInput{account: "ato", key: "key_ato", action: "hold", score: 75, at: testNow, review: "open", hold: strp("pending")})
	var later string
	// mixed: a confirmed takeover on one key, an engine-suspended block on another.
	stolen := dashboardDecision(t, f, dashboardDecisionInput{account: "mixed", key: "key_stolen", action: "hold", score: 75, at: testNow.Add(-time.Hour), review: "resolved", label: strp("takeover"), hold: strp("dropped")})
	suspend("key_stolen", "mixed", "owner", stolen)
	fine := dashboardDecision(t, f, dashboardDecisionInput{account: "mixed", key: "key_fine", action: "block", score: 90, at: testNow, review: "open"})
	suspend("key_fine", "mixed", "auto", fine)

	runSteps(t, f, []step{
		{
			name: "the profile counts and names what a resolution would close",
			path: "/v1/accounts/fp/profile", want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				open := openOf(t, w)
				if open.Reviews != 2 || open.PendingHolds != 1 || open.SuspendedKeys != 3 || open.RestorableKeys != 2 ||
					!slices.Equal(open.DecisionIDs, []string{hold, block}) {
					t.Errorf("open counts = %+v, want 2 reviews [hold block], 1 held, 3 suspended, 2 restorable", open)
				}
				if !slices.Equal(open.SuspendedKeyIDs, []string{"key_fp", "key_manual", "key_old"}) ||
					!slices.Equal(open.RestorableKeyIDs, []string{"key_fp", "key_old"}) ||
					!slices.Equal(open.ReviewKeyIDs, []string{"key_fp"}) {
					t.Errorf("keys = suspended %v, restorable %v, reviews %v", open.SuspendedKeyIDs, open.RestorableKeyIDs, open.ReviewKeyIDs)
				}
				if len(open.List) != 2 || open.List[0].DecisionID != hold || open.List[0].Action != "hold" ||
					open.List[0].HoldStatus == nil || *open.List[0].HoldStatus != "pending" || open.List[0].Driver != "new_asn" ||
					open.List[1].DecisionID != block || open.List[1].Score != 90 {
					t.Errorf("list = %+v, want the hold (pending, new_asn) then the block 90", open.List)
				}
				// The deadline: the held email is dropped 24 h after it was held.
				deadline := testNow.Add(24 * time.Hour)
				if open.HoldsExpireAt == nil || !open.HoldsExpireAt.Equal(deadline) ||
					open.List[0].HoldExpiresAt == nil || !open.List[0].HoldExpiresAt.Equal(deadline) || open.List[1].HoldExpiresAt != nil {
					t.Errorf("deadline = %v (list %v, %v), want %v on the hold only", open.HoldsExpireAt, open.List[0].HoldExpiresAt, open.List[1].HoldExpiresAt, deadline)
				}
			},
		},
		{
			name: "reviews the analyst didn't see: refused, nothing changes",
			path: "/v1/accounts/fp/resolve", body: resolve([]string{hold}, "legitimate", true, "x"), want: http.StatusConflict,
			check: func(t *testing.T, _ *httptest.ResponseRecorder) {
				if got := decision(t, block); got != "/open/" {
					t.Errorf("block = %s, want unchanged", got)
				}
			},
		},
		{
			name: "legitimate with restore: reviews close, the hold is released, the baseline learns, only safe keys return",
			path: "/v1/accounts/fp/resolve", body: resolve([]string{hold, block}, "legitimate", true, "owner confirmed"), want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := resolution(t, w)
				if got.Resolved != 2 || got.HoldsReleased != 1 || !slices.Equal(got.KeysRestored, []string{"key_fp", "key_old"}) {
					t.Errorf("legitimate = %+v, want 2 resolved, 1 hold released, key_fp and key_old restored", got)
				}
				checks := []struct{ what, got, want string }{
					{"hold", decision(t, hold), "legitimate/resolved/released"},
					{"block", decision(t, block), "legitimate/resolved/"},
					{"key_fp", keyStatus(t, "key_fp"), "active"},
					{"another account's key", keyStatus(t, "key_other"), "suspended"},
					{"the hand-suspended key", keyStatus(t, "key_manual"), "suspended"},
					{"AS14061 seen on key_fp", queryText(t, f, `select coalesce(key_asns->'key_fp'->>'14061','0') from profiles where account_id = 'fp'`), "2"},
					{"mark_legitimate audit rows", audits(t, "mark_legitimate", "key_fp", "account resolution: owner confirmed"), "2"},
					{"unblock_key audit rows", audits(t, "unblock_key", "key_fp", "account resolution: owner confirmed"), "1"},
				}
				for _, c := range checks {
					if c.got != c.want {
						t.Errorf("%s = %s, want %s", c.what, c.got, c.want)
					}
				}
				if !inSegment(t, "", "fp") {
					t.Error("account left the queue while a hand-suspended key is still suspended")
				}
			},
		},
		{
			name: "legitimate without restore keeps the key suspended and the account queued",
			path: "/v1/accounts/keep/resolve", body: resolve([]string{keep}, "legitimate", false, "later"), want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				if got := resolution(t, w); got.Resolved != 1 || len(got.KeysRestored) != 0 {
					t.Errorf("resolution = %+v, want 1 resolved, nothing restored", got)
				}
				if s := keyStatus(t, "key_keep"); s != "suspended" || !inSegment(t, "", "keep") {
					t.Errorf("key_keep = %s, queued %v; want suspended and queued", s, inSegment(t, "", "keep"))
				}
			},
		},
		{
			name: "legitimate with restore and nothing else open: the account leaves the queue for the baselines",
			path: "/v1/accounts/clean/resolve", body: resolve([]string{clean}, "legitimate", true, "rotated"), want: http.StatusOK,
			check: func(t *testing.T, _ *httptest.ResponseRecorder) {
				if inSegment(t, "", "clean") {
					t.Error("account is still in the queue")
				}
				if !inSegment(t, "segment=baseline&", "clean") {
					t.Error("account is missing from the legitimate baselines")
				}
			},
		},
		{
			name: "takeover: the hold is dropped and its key suspended by the analyst",
			path: "/v1/accounts/ato/resolve", body: resolve([]string{tk}, "takeover", false, "confirmed with owner"), want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := resolution(t, w)
				if got.Resolved != 1 || got.HoldsDropped != 1 || !slices.Equal(got.KeysSuspended, []string{"key_ato"}) {
					t.Errorf("takeover = %+v, want 1 resolved, 1 hold dropped, key_ato suspended", got)
				}
				wantText(t, f, "takeover decision", "takeover/resolved/dropped", `select coalesce(label,'') || '/' || review_status || '/' || coalesce(hold_status,'') from decisions where decision_id = $1`, tk)
				wantText(t, f, "key_ato", "suspended/analyst/"+tk, `select status || '/' || reason || '/' || decision_id from key_status where api_key_id = 'key_ato'`)
				if n := audits(t, "confirm_takeover", "key_ato", "account resolution: confirmed with owner"); n != "1" {
					t.Errorf("confirm_takeover audit rows = %s, want 1", n)
				}
			},
		},
		{
			name: "after a takeover, a later block's key is not restorable",
			setup: func(t *testing.T) {
				later = dashboardDecision(t, f, dashboardDecisionInput{account: "ato", key: "key_ato", action: "block", score: 90, at: testNow.Add(time.Hour), review: "open"})
				suspend("key_ato", "ato", "auto", later)
			},
			path: "/v1/accounts/ato/profile", want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				if c := openOf(t, w); c.RestorableKeys != 0 {
					t.Errorf("restorable keys = %d, want 0", c.RestorableKeys)
				}
			},
		},
		{
			name: "a legitimate resolution with restore still leaves that key suspended",
			path: "/v1/accounts/ato/resolve", body: func() any { return resolve([]string{later}, "legitimate", true, "x") }, want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				if got := resolution(t, w); len(got.KeysRestored) != 0 || keyStatus(t, "key_ato") != "suspended" {
					t.Errorf("restored a key with a confirmed takeover: %+v", got)
				}
			},
		},
		{
			name: "a takeover elsewhere on the account makes nothing restorable",
			path: "/v1/accounts/mixed/profile", want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				if c := openOf(t, w); c.RestorableKeys != 0 {
					t.Errorf("restorable keys = %d, want 0", c.RestorableKeys)
				}
			},
		},
		{
			name: "and a legitimate resolution there restores no key",
			path: "/v1/accounts/mixed/resolve", body: resolve([]string{fine}, "legitimate", true, "x"), want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := resolution(t, w)
				if len(got.KeysRestored) != 0 || keyStatus(t, "key_fine") != "suspended" || keyStatus(t, "key_stolen") != "suspended" {
					t.Errorf("restored a key on an account with a confirmed takeover: %+v", got)
				}
			},
		},
		{name: "nothing left to resolve as legitimate", path: "/v1/accounts/ato/resolve", body: func() any { return resolve([]string{later}, "legitimate", true, "x") }, want: http.StatusConflict},
		{name: "nothing left to resolve as takeover", path: "/v1/accounts/ato/resolve", body: func() any { return resolve([]string{later}, "takeover", false, "x") }, want: http.StatusConflict},
		{name: "the reviews seen are required", path: "/v1/accounts/fp/resolve", body: map[string]any{"outcome": "legitimate", "actor": "r", "reason": "x"}, want: http.StatusBadRequest},
		{name: "takeover can't restore keys", path: "/v1/accounts/fp/resolve", body: map[string]any{"decision_ids": []string{hold}, "outcome": "takeover", "restore_keys": true, "actor": "r", "reason": "x"}, want: http.StatusBadRequest},
		{name: "a reason is required", path: "/v1/accounts/fp/resolve", body: map[string]any{"decision_ids": []string{hold}, "outcome": "legitimate", "actor": "r"}, want: http.StatusBadRequest},
		{name: "the outcome must be legitimate or takeover", path: "/v1/accounts/fp/resolve", body: map[string]any{"decision_ids": []string{hold}, "outcome": "maybe", "actor": "r", "reason": "x"}, want: http.StatusBadRequest},
	})
}
