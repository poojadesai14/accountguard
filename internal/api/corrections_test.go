package api

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/poojadesai14/accountguard/internal/engine"
	"github.com/poojadesai14/accountguard/internal/store"
)

// An analyst can re-lock any key directly: the way back from a wrong legitimate call.
func TestSuspendKey(t *testing.T) {
	f := newAPIFixture(t)
	// A key never suspended before, with a pending hold.
	held := dashboardDecision(t, f, dashboardDecisionInput{account: "acct", key: "key_live", action: "hold", score: 70, at: testNow, review: "open", hold: strp("pending")})
	const path = "/v1/keys/key_live/suspend"
	// An attacker's backup: created by an account change, never used to send.
	execSQL(t, f, `insert into events(event_id,type,occurred_at,account_id,api_key_id,source,ip,change_kind,change_target_id)
		values('backup_created','account.change',$1,'acct','key_live','api','198.51.100.9','api_key.created','key_backup')`, testNow)
	runSteps(t, f, []step{
		{
			name: "a never-suspended key is suspended by the analyst, its held email dropped",
			path: path, body: map[string]any{"actor": "reviewer", "reason": "resolved by mistake"}, want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[map[string]any](t, w)
				if got["status"] != "suspended" || got["holds_dropped"] != float64(1) {
					t.Errorf("response = %v, want suspended with 1 hold dropped", got)
				}
				wantText(t, f, "key_live", "suspended/analyst/-", `select status || '/' || reason || '/' || coalesce(decision_id::text,'-') from key_status where api_key_id = 'key_live'`)
				wantText(t, f, "hold", "dropped", `select hold_status from decisions where decision_id = $1`, held)
				wantText(t, f, "suspend_key audit rows", "1", `select count(*)::text from analyst_actions where action = 'suspend_key' and api_key_id = 'key_live' and actor = 'reviewer'`)
			},
		},
		{name: "suspending it again is refused", path: path, body: map[string]any{"actor": "r", "reason": "x"}, want: http.StatusConflict},
		{name: "an unknown key is not found", path: "/v1/keys/key_nobody/suspend", body: map[string]any{"actor": "r", "reason": "x"}, want: http.StatusNotFound},
		{name: "a reason is required", path: path, body: map[string]any{"actor": "r"}, want: http.StatusBadRequest},
		{
			name: "a created key that never sent is suspended under the account that created it",
			path: "/v1/keys/key_backup/suspend", body: map[string]any{"actor": "r", "reason": "created during the takeover"}, want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				wantText(t, f, "key_backup", "acct/suspended/analyst", `select account_id || '/' || status || '/' || reason from key_status where api_key_id = 'key_backup'`)
			},
		},
		{name: "the ordinary restore undoes it", path: "/v1/keys/key_live/unblock", body: map[string]any{"actor": "r", "reason": "owner rotated"}, want: http.StatusOK},
	})
}

// A takeover resolved as legitimate by mistake can be corrected: labels flip to
// takeover, the baseline forgets the attacker's network and domain, and the key is
// suspended again (QA: sim_1101_0747_011).
func TestCorrectToTakeover(t *testing.T) {
	f := newAPIFixture(t)
	const baseline = `select events_seen || ' ' || coalesce(key_asns->'key_w'->>'14061','-') || ' ' || coalesce(known_domains->>'docs-share-portal.com','-') from profiles where account_id = 'wrong'`

	// The attack: a block with a young phishing domain that auto-suspended the key.
	block := dashboardDecision(t, f, dashboardDecisionInput{account: "wrong", key: "key_w", action: "block", score: 90, at: testNow, review: "open"})
	execSQL(t, f, `update events set link_domains = '{docs-share-portal.com}' where event_id = (select event_id from decisions where decision_id = $1)`, block)
	execSQL(t, f, `update decisions set hits = '[{"name":"young_domain","category":"content","points":20,"detail":"docs-share-portal.com registered 6 days ago"}]' where decision_id = $1`, block)
	execSQL(t, f, `insert into key_status(api_key_id,account_id,status,reason,decision_id) values('key_w','wrong','suspended','auto',$1)`, block)
	other := dashboardDecision(t, f, dashboardDecisionInput{account: "else", key: "key_e", action: "block", score: 90, at: testNow.Add(time.Hour), review: "resolved", label: strp("legitimate")})
	resolve := func(confirm string) map[string]any {
		return map[string]any{"decision_ids": []string{block}, "outcome": "legitimate", "restore_keys": true, "confirm": confirm, "actor": "reviewer", "reason": "looks fine"}
	}
	correct := func(ids []string) map[string]any {
		return map[string]any{"decision_ids": ids, "actor": "r", "reason": "x"}
	}
	type profile struct {
		Open       store.OpenCounts         `json:"open"`
		Legitimate []store.ReviewedDecision `json:"legitimate_decisions"`
	}

	runSteps(t, f, []step{
		{
			name: "the profile warns that the open review shows a young domain",
			path: "/v1/accounts/wrong/profile", want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				if open := decodeResponse[profile](t, w).Open; len(open.Warnings) != 1 || open.Warnings[0].Signal != "young_domain" {
					t.Errorf("warnings = %+v, want young_domain", open.Warnings)
				}
			},
		},
		{name: "legitimate without the typed account is refused", path: "/v1/accounts/wrong/resolve", body: resolve(""), want: http.StatusConflict},
		{
			name: "legitimate with another account's ID is refused, and changes nothing",
			path: "/v1/accounts/wrong/resolve", body: resolve("not-this-account"), want: http.StatusConflict,
			check: func(t *testing.T, _ *httptest.ResponseRecorder) {
				wantText(t, f, "block label", "", `select coalesce(label,'') from decisions where decision_id = $1`, block)
			},
		},
		{
			name: "the confirmed wrong call teaches the baseline the attacker",
			path: "/v1/accounts/wrong/resolve", body: resolve("wrong"), want: http.StatusOK,
			check: func(t *testing.T, _ *httptest.ResponseRecorder) {
				wantText(t, f, "baseline (events, key ASN, domain)", "101 1 1", baseline)
			},
		},
		{
			name: "the profile lists the decision that can be corrected",
			path: "/v1/accounts/wrong/profile", want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				listed := decodeResponse[profile](t, w).Legitimate
				if len(listed) != 1 || listed[0].DecisionID != block || listed[0].Driver != "young_domain" {
					t.Errorf("legitimate decisions = %+v, want the block", listed)
				}
			},
		},
		{
			name: "the correction relabels, unlearns, re-suspends and audits (duplicate IDs count once)",
			path: "/v1/accounts/wrong/correct", body: map[string]any{"decision_ids": []string{block, block}, "actor": "reviewer", "reason": "phishing domain"}, want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				got := decodeResponse[engine.Correction](t, w)
				if got.Corrected != 1 || !slices.Equal(got.KeysSuspended, []string{"key_w"}) {
					t.Errorf("correct = %+v, want 1 corrected, key_w suspended", got)
				}
				wantText(t, f, "block", "takeover/resolved", `select label || '/' || review_status from decisions where decision_id = $1`, block)
				wantText(t, f, "key_w", "suspended/analyst/"+block, `select status || '/' || reason || '/' || decision_id from key_status where api_key_id = 'key_w'`)
				wantText(t, f, "baseline (events, key ASN, domain)", "100 - -", baseline)
				wantText(t, f, "correct_to_takeover audit rows", "1", `select count(*)::text from analyst_actions where action = 'correct_to_takeover' and decision_id = $1 and api_key_id = 'key_w' and reason = 'correction: phishing domain'`, block)
			},
		},
		{
			name: "after a takeover nothing offers to restore the key",
			path: "/v1/accounts/wrong/profile", want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				if c := decodeResponse[profile](t, w).Open; c.RestorableKeys != 0 {
					t.Errorf("restorable keys = %d, want 0", c.RestorableKeys)
				}
			},
		},
		{name: "a decision already takeover can't be corrected again", path: "/v1/accounts/wrong/correct", body: correct([]string{block}), want: http.StatusConflict},
		{
			name: "another account's decision can't be corrected through this one",
			path: "/v1/accounts/wrong/correct", body: correct([]string{other}), want: http.StatusConflict,
			check: func(t *testing.T, _ *httptest.ResponseRecorder) {
				wantText(t, f, "other account's label", "legitimate", `select label from decisions where decision_id = $1`, other)
			},
		},
		{name: "a malformed ID is refused", path: "/v1/accounts/wrong/correct", body: correct([]string{"not-a-uuid"}), want: http.StatusBadRequest},
		{name: "no IDs is refused", path: "/v1/accounts/wrong/correct", body: correct(nil), want: http.StatusBadRequest},
	})
}

// Marking one decision legitimate over attacker-looking evidence needs the account
// ID typed, like Resolve account (QA: sim_1101_0747_079); the owner's own answer
// to a hold doesn't.
func TestMarkLegitimateNeedsConfirmOverRiskyEvidence(t *testing.T) {
	f := newAPIFixture(t)
	const spike = `[{"name":"recipient_spike","category":"volume","points":15,"detail":"223 recipients vs normal 68/hour"}]`
	risky := dashboardDecision(t, f, dashboardDecisionInput{account: "spiky", key: "key_s", action: "block", score: 90, at: testNow, review: "open"})
	execSQL(t, f, `update decisions set hits = $2 where decision_id = $1`, risky, spike)
	plain := dashboardDecision(t, f, dashboardDecisionInput{account: "plain", key: "key_p", action: "hold", score: 70, at: testNow, review: "open", hold: strp("pending")})
	owned := dashboardDecision(t, f, dashboardDecisionInput{account: "owned", key: "key_o", action: "hold", score: 75, at: testNow, review: "open", hold: strp("pending")})
	execSQL(t, f, `update decisions set hits = $2 where decision_id = $1`, owned, spike)
	mark := func(confirm string) map[string]any {
		return map[string]any{"action": "mark_legitimate", "confirm": confirm, "actor": "reviewer", "reason": "owner says fine"}
	}

	tests := []struct {
		name string
		path string
		body any
		want int
	}{
		{name: "risky evidence without confirmation is refused", path: "/v1/decisions/" + risky + "/actions", body: mark(""), want: http.StatusConflict},
		{name: "risky evidence with another account's ID is refused", path: "/v1/decisions/" + risky + "/actions", body: mark("someone_else"), want: http.StatusConflict},
		{name: "risky evidence with the account ID is accepted", path: "/v1/decisions/" + risky + "/actions", body: mark("spiky"), want: http.StatusOK},
		{name: "ordinary evidence needs no confirmation", path: "/v1/decisions/" + plain + "/actions", body: map[string]any{"action": "mark_legitimate", "actor": "r", "reason": "new laptop"}, want: http.StatusOK},
		{name: "the owner answering their own hold types nothing", path: "/v1/holds/" + owned + "/owner-response", body: map[string]any{"response": "this_was_me"}, want: http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requireStatus(t, f.post(tt.path, tt.body), tt.want)
		})
	}
}

// Restoring a key stopped for risky signals shows that evidence and needs the
// account ID typed, even after its emails were marked legitimate
// (QA: sim_1101_0747_012); a key stopped for ordinary signals restores in one step.
func TestRestoreNeedsConfirmOverRiskyEvidence(t *testing.T) {
	f := newAPIFixture(t)
	risky := dashboardDecision(t, f, dashboardDecisionInput{account: "resent", key: "key_r", action: "block", score: 90, at: testNow, review: "resolved", label: strp("legitimate")})
	execSQL(t, f, `update decisions set hits = '[{"name":"young_domain","category":"content","points":20,"detail":"invoice-portal.net registered 6 days ago"},{"name":"new_asn","category":"network","points":30,"detail":"AS49453 first seen"}]' where decision_id = $1`, risky)
	execSQL(t, f, `insert into key_status(api_key_id,account_id,status,reason,decision_id) values('key_r','resent','suspended','auto',$1)`, risky)
	plain := dashboardDecision(t, f, dashboardDecisionInput{account: "plain_key", key: "key_p", action: "block", score: 85, at: testNow, review: "resolved", label: strp("legitimate")})
	execSQL(t, f, `insert into key_status(api_key_id,account_id,status,reason,decision_id) values('key_p','plain_key','suspended','auto',$1)`, plain)
	restore := func(confirm string) map[string]any {
		return map[string]any{"confirm": confirm, "actor": "r", "reason": "owner says fine"}
	}

	runSteps(t, f, []step{
		{
			name: "the key lists the risky signal it was stopped for, not the ordinary one",
			path: "/v1/accounts/resent/profile", want: http.StatusOK,
			check: func(t *testing.T, w *httptest.ResponseRecorder) {
				keys := decodeResponse[struct {
					Keys []store.KeyStatus `json:"key_status"`
				}](t, w).Keys
				if len(keys) != 1 || len(keys[0].Warnings) != 1 || keys[0].Warnings[0].Signal != "young_domain" {
					t.Errorf("key warnings = %+v, want young_domain only", keys)
				}
				want := store.KeyCause{Action: "block", Score: 90, Signals: []string{"new_asn", "young_domain"}}
				if len(keys) == 1 && (keys[0].Cause == nil || !reflect.DeepEqual(*keys[0].Cause, want)) {
					t.Errorf("key cause = %+v, want %+v", keys[0].Cause, want)
				}
			},
		},
		{name: "restoring without confirmation is refused", path: "/v1/keys/key_r/unblock", body: restore(""), want: http.StatusConflict},
		{name: "restoring with another account's ID is refused", path: "/v1/keys/key_r/unblock", body: restore("other"), want: http.StatusConflict},
		{name: "restoring with the account ID is accepted", path: "/v1/keys/key_r/unblock", body: restore("resent"), want: http.StatusOK},
		{name: "a key stopped for ordinary signals restores in one step", path: "/v1/keys/key_p/unblock", body: map[string]any{"actor": "r", "reason": "rotated"}, want: http.StatusOK},
	})
}
