package engine

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/store"
	"github.com/poojadesai14/resend-ato/migrations"
)

// Integration tests: need TEST_DATABASE_URL (e.g. the docker-compose database). Each test uses
// fresh random account ids, so they don't interfere with each other or with seeded data.
func testService(t *testing.T) *Service {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := store.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err := store.Migrate(ctx, s.Pool, migrations.FS); err != nil {
		t.Fatal(err)
	}
	return &Service{Store: s, Config: testConfig(t)}
}

type fixture struct {
	t       *testing.T
	svc     *Service
	account string
	n       int
}

func newFixture(t *testing.T) *fixture {
	return &fixture{t: t, svc: testService(t), account: fmt.Sprintf("acc_test_%d", rand.Int64())}
}

func (f *fixture) send(at time.Time, asn int, link string) *event.Event {
	f.n++
	return &event.Event{
		EventID: fmt.Sprintf("%s_evt_%d", f.account, f.n), Type: event.TypeEmailSend, OccurredAt: at,
		AccountID: f.account, APIKeyID: f.account + "_key", Source: "api",
		Network: event.Network{IP: "203.0.113.9", ASN: asn},
		Email: &event.Email{From: "billing@acme.com", To: event.StringList{"a@example.org"},
			HTML: `<a href="https://` + link + `/x">x</a>`},
	}
}

func (f *fixture) handle(ev *event.Event) *store.Decision {
	f.t.Helper()
	d, err := f.svc.Handle(context.Background(), ev)
	if err != nil {
		f.t.Fatalf("handle %s: %v", ev.EventID, err)
	}
	return d
}

// history sends 60 allowed emails, one per hour, from AWS linking to stripe.com.
func (f *fixture) history(start time.Time) time.Time {
	for i := 0; i < 60; i++ {
		if d := f.handle(f.send(start.Add(time.Duration(i)*time.Hour), 16509, "stripe.com")); d.Action != "allow" {
			f.t.Fatalf("history event %d: %s %+v", i, d.Action, d.Hits)
		}
	}
	return start.Add(60 * time.Hour)
}

func (f *fixture) profileRow() (eventsSeen int, keyASNs map[string]map[string]int, lastChange *time.Time) {
	f.t.Helper()
	err := f.svc.Store.Pool.QueryRow(context.Background(),
		`select events_seen, key_asns, last_change_at from profiles where account_id = $1`, f.account,
	).Scan(&eventsSeen, &keyASNs, &lastChange)
	if err != nil {
		f.t.Fatal(err)
	}
	return
}

func TestServiceIdempotent(t *testing.T) {
	f := newFixture(t)
	ev := f.send(now, 16509, "stripe.com")
	first, second := f.handle(ev), f.handle(ev)
	if first.DecisionID == "" || first.DecisionID != second.DecisionID {
		t.Errorf("duplicate event got a new decision: %s vs %s", first.DecisionID, second.DecisionID)
	}
	if seen, _, _ := f.profileRow(); seen != 1 {
		t.Errorf("events_seen = %d after duplicate, want 1", seen)
	}
}

func TestServiceTakeoverHoldsThenBlocksAndDoesNotLearn(t *testing.T) {
	f := newFixture(t)
	t0 := f.history(now.AddDate(0, 0, -5))

	hold := f.handle(f.send(t0, 14061, "invoice-portal.net"))
	if hold.Action != "hold" || hold.Score != 75 || hold.HoldStatus == nil || *hold.HoldStatus != "pending" {
		t.Fatalf("takeover send: %s %d hold_status=%v hits=%+v", hold.Action, hold.Score, hold.HoldStatus, hold.Hits)
	}
	seen, asns, _ := f.profileRow()
	if seen != 60 || asns[f.account+"_key"]["14061"] != 0 {
		t.Errorf("held event changed the baseline: events_seen=%d asns=%v", seen, asns)
	}

	// The same attacker repeats; the held sends count toward the velocity window.
	var last *store.Decision
	for i := 1; i <= 40 && (last == nil || last.Action != "block"); i++ {
		ev := f.send(t0.Add(time.Duration(i)*time.Second), 14061, "invoice-portal.net")
		ev.Email.To = event.StringList{"a@x.org", "b@x.org", "c@x.org", "d@x.org", "e@x.org"}
		last = f.handle(ev)
	}
	if last.Action != "block" || last.Score != 90 {
		t.Fatalf("spike never blocked: %s %d %+v", last.Action, last.Score, last.Hits)
	}

	next := f.handle(f.send(t0.Add(time.Minute), 16509, "stripe.com"))
	if next.Action != "block" || next.Reason == nil || *next.Reason != ReasonKeySuspended {
		t.Errorf("event after block: %s reason=%v", next.Action, next.Reason)
	}
}

func TestServiceRecordsAccountChangeEvenWhenNotAllowed(t *testing.T) {
	f := newFixture(t)
	t0 := f.history(now.AddDate(0, 0, -5))

	change := f.send(t0, 14061, "")
	change.Type, change.Email, change.Change = event.TypeAccountChange, nil, &event.Change{Kind: "api_key.created"}
	d := f.handle(change)
	if d.Action != "flag" || d.Score != 50 {
		t.Fatalf("new-network key creation: %s %d %+v", d.Action, d.Score, d.Hits)
	}
	_, asns, lastChange := f.profileRow()
	if lastChange == nil || !lastChange.Equal(t0) {
		t.Errorf("last_change_at = %v, want %v", lastChange, t0)
	}
	if asns[f.account+"_key"]["14061"] != 0 {
		t.Error("flagged event taught the baseline its ASN")
	}

	// A normal-looking send 10 minutes later still carries the account-change points.
	d = f.handle(f.send(t0.Add(10*time.Minute), 16509, "stripe.com"))
	if d.Score != 20 || len(d.Hits) != 1 || d.Hits[0].Name != "recent_account_change" {
		t.Errorf("send after change: %d %+v", d.Score, d.Hits)
	}
}

func TestServiceConcurrentEventsOnOneAccount(t *testing.T) {
	f := newFixture(t)
	const n = 20
	evs := make([]*event.Event, n)
	for i := range evs {
		evs[i] = f.send(now.Add(time.Duration(i)*time.Second), 16509, "stripe.com")
	}
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for _, ev := range evs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.svc.Handle(context.Background(), ev); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if seen, _, _ := f.profileRow(); seen != n {
		t.Errorf("events_seen = %d, want %d (lost updates)", seen, n)
	}
}
