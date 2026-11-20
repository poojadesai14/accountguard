package engine

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/poojadesai14/accountguard/internal/store"
)

func (f *fixture) keyStatus() (status, reason string) {
	f.t.Helper()
	err := f.svc.Store.Pool.QueryRow(context.Background(),
		`select status, reason from key_status where api_key_id = $1`, f.account+"_key").Scan(&status, &reason)
	if err != nil {
		f.t.Fatal(err)
	}
	return
}

func (f *fixture) holdStatus(decisionID string) string {
	f.t.Helper()
	d, err := store.DecisionByID(context.Background(), f.svc.Store.Pool, decisionID, false)
	if err != nil {
		f.t.Fatal(err)
	}
	return *d.HoldStatus
}

func isConflict(err error) bool {
	var c *ConflictError
	return errors.As(err, &c)
}

func TestConfirmTakeoverSuspendsKeyAndDropsHolds(t *testing.T) {
	tests := []struct {
		name         string
		pendingHolds int
	}{
		{
			name:         "suspends a key with one hold",
			pendingHolds: 1,
		},
		{
			name:         "drops every pending hold for the key",
			pendingHolds: 2,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.Background()
			at := f.history(now.AddDate(0, 0, -5))
			holds := make([]*store.Decision, tt.pendingHolds)
			for i := range holds {
				holds[i] = f.handle(f.send(at.Add(time.Duration(i)*time.Second), 14061, "invoice-portal.net"))
				if holds[i].Action != "hold" {
					t.Fatalf("fixture decision = %s, want hold", holds[i].Action)
				}
			}
			decision, err := f.svc.ApplyAction(ctx, holds[0].DecisionID, ActConfirmTakeover, "", Who{Actor: "pooja", Reason: "phishing link"})
			if err != nil {
				t.Fatal(err)
			}
			if decision.Label == nil || *decision.Label != "takeover" || decision.ReviewStatus != "resolved" {
				t.Errorf("confirmed decision = %+v, want takeover/resolved", decision)
			}
			if status, reason := f.keyStatus(); status != "suspended" || reason != "analyst" {
				t.Errorf("key = %s/%s, want suspended/analyst", status, reason)
			}
			for _, hold := range holds {
				if got := f.holdStatus(hold.DecisionID); got != "dropped" {
					t.Errorf("hold %s = %q, want dropped", hold.DecisionID, got)
				}
			}
			if _, err := f.svc.ApplyAction(ctx, holds[0].DecisionID, ActConfirmTakeover, "", Who{Actor: "pooja", Reason: "again"}); !isConflict(err) {
				t.Errorf("repeated confirmation error = %v, want conflict", err)
			}
			if err := f.svc.UnblockKey(ctx, f.account+"_key", f.account, Who{Actor: "pooja", Reason: "owner rotated key"}); err != nil {
				t.Fatal(err)
			}
			if got := f.handle(f.send(at.Add(time.Minute), 16509, "stripe.com")); got.Action != "allow" {
				t.Errorf("after restoring access = %s, want allow", got.Action)
			}
			if err := f.svc.UnblockKey(ctx, f.account+"_key", f.account, Who{Actor: "pooja", Reason: "again"}); !isConflict(err) {
				t.Errorf("restoring active key error = %v, want conflict", err)
			}
		})
	}
}
func TestMarkLegitimateTeachesBaseline(t *testing.T) {
	tests := []struct {
		name string
		asn  int
	}{
		{
			name: "DigitalOcean migration",
			asn:  14061,
		},
		{
			name: "Cloudflare migration",
			asn:  13335,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			at := f.history(now.AddDate(0, 0, -5))
			migration := f.handle(f.send(at, tt.asn, "stripe.com"))
			if migration.Action != "flag" {
				t.Fatalf("migration = %s, want flag", migration.Action)
			}
			if _, err := f.svc.ApplyAction(context.Background(), migration.DecisionID, ActMarkLegitimate, "", Who{Actor: "pooja", Reason: "infrastructure migration"}); err != nil {
				t.Fatal(err)
			}
			got := f.handle(f.send(at.Add(time.Minute), tt.asn, "stripe.com"))
			if got.Action != "allow" || got.Score != 0 {
				t.Errorf("after approval = %s/%d, want allow/0 (hits %+v)", got.Action, got.Score, got.Hits)
			}
		})
	}
}
func TestReleaseHoldAndOwnerResponses(t *testing.T) {
	tests := []struct {
		name, action, ownerResponse, wantHold, wantLabel, wantKeyReason string
	}{
		{
			name:     "analyst releases without a label",
			action:   ActReleaseHold,
			wantHold: "released",
		},
		{
			name:          "owner denies the activity",
			ownerResponse: "not_me",
			wantHold:      "dropped",
			wantLabel:     "takeover",
			wantKeyReason: "owner",
		},
		{
			name:          "owner confirms legitimate activity",
			ownerResponse: "this_was_me",
			wantHold:      "released",
			wantLabel:     "legitimate",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.Background()
			at := f.history(now.AddDate(0, 0, -5))
			hold := f.handle(f.send(at, 14061, "invoice-portal.net"))
			apply := func() (*store.Decision, error) {
				if tt.ownerResponse != "" {
					return f.svc.OwnerRespond(ctx, hold.DecisionID, tt.ownerResponse)
				}
				return f.svc.ApplyAction(ctx, hold.DecisionID, tt.action, "", Who{Actor: "pooja", Reason: "reviewed evidence"})
			}
			decision, err := apply()
			if err != nil {
				t.Fatal(err)
			}
			if got := f.holdStatus(hold.DecisionID); got != tt.wantHold {
				t.Errorf("hold = %q, want %q", got, tt.wantHold)
			}
			if tt.wantLabel == "" {
				if decision.Label != nil {
					t.Errorf("label = %v, want none", decision.Label)
				}
			} else if decision.Label == nil || *decision.Label != tt.wantLabel {
				t.Errorf("label = %v, want %q", decision.Label, tt.wantLabel)
			}
			if tt.wantKeyReason != "" {
				if status, reason := f.keyStatus(); status != "suspended" || reason != tt.wantKeyReason {
					t.Errorf("key = %s/%s, want suspended/%s", status, reason, tt.wantKeyReason)
				}
			}
			if _, err := apply(); !isConflict(err) {
				t.Errorf("repeated action error = %v, want conflict", err)
			}
			if _, err := f.svc.OwnerRespond(ctx, hold.DecisionID, "not_me"); !isConflict(err) {
				t.Errorf("owner response after resolution = %v, want conflict", err)
			}
		})
	}
}
func TestActionMissingResources(t *testing.T) {
	tests := []struct{ name, resource string }{
		{
			name:     "unknown decision",
			resource: "decision",
		},
		{
			name:     "unknown key",
			resource: "key",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.Background()
			var err error
			if tt.resource == "key" {
				err = f.svc.UnblockKey(ctx, "no_such_key", "", Who{Actor: "pooja", Reason: "reviewed evidence"})
			} else {
				_, err = f.svc.ApplyAction(ctx, "00000000-0000-0000-0000-000000000000", ActReleaseHold, "", Who{Actor: "pooja", Reason: "reviewed evidence"})
			}
			if !errors.Is(err, ErrNotFound) {
				t.Errorf("error = %v, want ErrNotFound", err)
			}
		})
	}
}
func TestExpireHolds(t *testing.T) {
	tests := []struct {
		name       string
		expiresIn  time.Duration
		wantStatus string
	}{
		{
			name:       "past deadline expires",
			expiresIn:  -time.Minute,
			wantStatus: "expired",
		},
		{
			name:       "future deadline remains pending",
			expiresIn:  time.Hour,
			wantStatus: "pending",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.Background()
			at := f.history(now.AddDate(0, 0, -5))
			hold := f.handle(f.send(at, 14061, "invoice-portal.net"))
			if _, err := f.svc.Store.Pool.Exec(ctx, `update decisions set hold_expires_at = now() + ($1 * interval '1 second') where decision_id = $2::uuid`, tt.expiresIn.Seconds(), hold.DecisionID); err != nil {
				t.Fatal(err)
			}
			if _, err := store.ExpireHolds(ctx, f.svc.Store.Pool); err != nil {
				t.Fatal(err)
			}
			if got := f.holdStatus(hold.DecisionID); got != tt.wantStatus {
				t.Errorf("hold = %q, want %q", got, tt.wantStatus)
			}
		})
	}
}
