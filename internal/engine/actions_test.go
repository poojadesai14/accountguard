package engine

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/store"
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
	f := newFixture(t)
	ctx := context.Background()
	t0 := f.history(now.AddDate(0, 0, -5))

	h1 := f.handle(f.send(t0, 14061, "invoice-portal.net"))
	h2 := f.handle(f.send(t0.Add(time.Second), 14061, "invoice-portal.net"))
	if h1.Action != "hold" || h2.Action != "hold" {
		t.Fatalf("setup: %s %s", h1.Action, h2.Action)
	}

	d, err := f.svc.ApplyAction(ctx, h1.DecisionID, ActConfirmTakeover, "pooja", "phishing link")
	if err != nil {
		t.Fatal(err)
	}
	if *d.Label != "takeover" || d.ReviewStatus != "resolved" {
		t.Errorf("decision after confirm: label=%v review=%s", d.Label, d.ReviewStatus)
	}
	if status, reason := f.keyStatus(); status != "suspended" || reason != "analyst" {
		t.Errorf("key = %s/%s", status, reason)
	}
	if got := f.holdStatus(h2.DecisionID); got != "dropped" {
		t.Errorf("other pending hold = %s, want dropped", got)
	}
	if _, err := f.svc.ApplyAction(ctx, h1.DecisionID, ActConfirmTakeover, "pooja", "again"); !isConflict(err) {
		t.Errorf("second confirm err = %v, want conflict", err)
	}

	if err := f.svc.UnblockKey(ctx, f.account+"_key", "pooja", "owner rotated key"); err != nil {
		t.Fatal(err)
	}
	if d := f.handle(f.send(t0.Add(time.Minute), 16509, "stripe.com")); d.Action != "allow" {
		t.Errorf("after unblock: %s %+v", d.Action, d.Hits)
	}
	if err := f.svc.UnblockKey(ctx, f.account+"_key", "pooja", "again"); !isConflict(err) {
		t.Errorf("unblock active key err = %v, want conflict", err)
	}
	if err := f.svc.UnblockKey(ctx, "no_such_key", "pooja", "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unblock unknown key err = %v, want not found", err)
	}
}

func TestMarkLegitimateTeachesBaseline(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	t0 := f.history(now.AddDate(0, 0, -5))

	migrated := f.handle(f.send(t0, 14061, "stripe.com"))
	if migrated.Action != "flag" {
		t.Fatalf("setup: %s %+v", migrated.Action, migrated.Hits)
	}
	if _, err := f.svc.ApplyAction(ctx, migrated.DecisionID, ActMarkLegitimate, "pooja", "moved to DigitalOcean"); err != nil {
		t.Fatal(err)
	}
	// The key has 60 events, so its own ASN set is used: 14061 is now in it.
	if d := f.handle(f.send(t0.Add(time.Minute), 14061, "stripe.com")); d.Action != "allow" || d.Score != 0 {
		t.Errorf("after mark legitimate: %s %d %+v", d.Action, d.Score, d.Hits)
	}
}

func TestReleaseHoldAndOwnerResponses(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	t0 := f.history(now.AddDate(0, 0, -5))

	h := f.handle(f.send(t0, 14061, "invoice-portal.net"))
	if _, err := f.svc.ApplyAction(ctx, h.DecisionID, ActReleaseHold, "pooja", "looks fine"); err != nil {
		t.Fatal(err)
	}
	if got := f.holdStatus(h.DecisionID); got != "released" {
		t.Errorf("hold = %s", got)
	}
	if _, err := f.svc.ApplyAction(ctx, h.DecisionID, ActReleaseHold, "pooja", "again"); !isConflict(err) {
		t.Errorf("second release err = %v, want conflict", err)
	}
	if _, err := f.svc.OwnerRespond(ctx, h.DecisionID, "not_me"); !isConflict(err) {
		t.Errorf("owner response on released hold err = %v, want conflict", err)
	}

	h2 := f.handle(f.send(t0.Add(time.Second), 14061, "invoice-portal.net"))
	d, err := f.svc.OwnerRespond(ctx, h2.DecisionID, "not_me")
	if err != nil {
		t.Fatal(err)
	}
	if *d.Label != "takeover" {
		t.Errorf("owner not_me label = %v", d.Label)
	}
	if status, reason := f.keyStatus(); status != "suspended" || reason != "owner" {
		t.Errorf("key = %s/%s", status, reason)
	}

	if _, err := f.svc.ApplyAction(ctx, "00000000-0000-0000-0000-000000000000", ActReleaseHold, "pooja", "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown decision err = %v", err)
	}
}

func TestExpireHolds(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	t0 := f.history(now.AddDate(0, 0, -5))
	h := f.handle(f.send(t0, 14061, "invoice-portal.net"))

	if _, err := f.svc.Store.Pool.Exec(ctx,
		`update decisions set hold_expires_at = now() - interval '1 minute' where decision_id = $1::uuid`, h.DecisionID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ExpireHolds(ctx, f.svc.Store.Pool); err != nil {
		t.Fatal(err)
	}
	if got := f.holdStatus(h.DecisionID); got != "expired" {
		t.Errorf("hold = %s, want expired", got)
	}
}
