package engine

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
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
	cfg := testConfig(t)
	// These tests assert transaction and scoring behavior, not latency. Race
	// instrumentation and serialized account locks can exceed the production
	// deadline on shared CI runners. Timeout behavior has a dedicated API test.
	cfg.Scoring.TimeoutMS = 5000
	return &Service{Store: s, Config: cfg}
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
	tests := []struct {
		name       string
		deliveries int
	}{
		{
			name:       "one retry reuses the decision",
			deliveries: 2,
		},
		{
			name:       "repeated retries learn the event only once",
			deliveries: 5,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			ev := f.send(now, 16509, "stripe.com")
			first := f.handle(ev)
			if first.DecisionID == "" {
				t.Fatal("first delivery has no decision ID")
			}
			for attempt := 1; attempt < tt.deliveries; attempt++ {
				if got := f.handle(ev); got.DecisionID != first.DecisionID {
					t.Errorf("delivery %d decision = %q, want %q", attempt+1, got.DecisionID, first.DecisionID)
				}
			}
			if seen, _, _ := f.profileRow(); seen != 1 {
				t.Errorf("learned events = %d, want 1", seen)
			}
		})
	}
}
func TestServiceTakeoverHoldsThenBlocksAndDoesNotLearn(t *testing.T) {
	tests := []struct {
		name              string
		recipientsPerSend int
	}{
		{
			name:              "repeated single-recipient attack",
			recipientsPerSend: 1,
		},
		{
			name:              "repeated batch attack",
			recipientsPerSend: 5,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			at := f.history(now.AddDate(0, 0, -5))
			hold := f.handle(f.send(at, 14061, "invoice-portal.net"))
			if hold.Action != "hold" || hold.Score != 75 || hold.HoldStatus == nil || *hold.HoldStatus != "pending" {
				t.Fatalf("first attack = %s/%d, hold status %v; want hold/75/pending", hold.Action, hold.Score, hold.HoldStatus)
			}
			if seen, asns, _ := f.profileRow(); seen != 60 || asns[f.account+"_key"]["14061"] != 0 {
				t.Errorf("held event changed baseline: events=%d ASNs=%v", seen, asns)
			}
			// Held sends contribute to velocity even though they do not teach the baseline.
			var blocked *store.Decision
			for attempt := 1; attempt <= 40; attempt++ {
				ev := f.send(at.Add(time.Duration(attempt)*time.Second), 14061, "invoice-portal.net")
				ev.Email.To = make(event.StringList, tt.recipientsPerSend)
				for i := range ev.Email.To {
					ev.Email.To[i] = fmt.Sprintf("recipient%d@example.org", i)
				}
				got := f.handle(ev)
				if got.Action == "block" {
					blocked = got
					break
				}
			}
			if blocked == nil {
				t.Fatal("attack never reached block")
			}
			if blocked.Score != 90 {
				t.Errorf("blocked score = %d, want 90", blocked.Score)
			}
			next := f.handle(f.send(at.Add(time.Minute), 16509, "stripe.com"))
			if next.Action != "block" || next.Reason == nil || *next.Reason != ReasonKeySuspended {
				t.Errorf("event after suspension = %s, reason %v; want block/key_suspended", next.Action, next.Reason)
			}
		})
	}
}
func TestServiceOpensReviewsOnlyForHoldAndBlock(t *testing.T) {
	f := newFixture(t)
	at := f.history(now.AddDate(0, 0, -5))
	flag := f.handle(f.send(at, 14061, "stripe.com"))
	if flag.Action != "flag" || flag.ReviewStatus != "none" {
		t.Errorf("new ASN alone = %s/%s, want flag/none", flag.Action, flag.ReviewStatus)
	}
	hold := f.handle(f.send(at.Add(time.Second), 14061, "invoice-portal.net"))
	if hold.Action != "hold" || hold.ReviewStatus != "open" {
		t.Errorf("new ASN and new domain = %s/%s, want hold/open", hold.Action, hold.ReviewStatus)
	}
}
func TestServiceRecordsAccountChangeEvenWhenNotAllowed(t *testing.T) {
	tests := []struct {
		name                                 string
		asn                                  int
		wantAction                           string
		wantScore, wantLearned, wantASNCount int
	}{
		{
			name:         "allowed change on known network",
			asn:          16509,
			wantAction:   "allow",
			wantScore:    20,
			wantLearned:  61,
			wantASNCount: 61,
		},
		{
			name:         "flagged change on new network",
			asn:          14061,
			wantAction:   "flag",
			wantScore:    50,
			wantLearned:  60,
			wantASNCount: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			at := f.history(now.AddDate(0, 0, -5))
			change := f.send(at, tt.asn, "")
			change.Type, change.Email, change.Change = event.TypeAccountChange, nil, &event.Change{Kind: "api_key.created"}
			got := f.handle(change)
			if got.Action != tt.wantAction || got.Score != tt.wantScore {
				t.Fatalf("change decision = %s/%d, want %s/%d", got.Action, got.Score, tt.wantAction, tt.wantScore)
			}
			seen, asns, lastChange := f.profileRow()
			if lastChange == nil || !lastChange.Equal(at) {
				t.Errorf("last change = %v, want %v", lastChange, at)
			}
			if seen != tt.wantLearned || asns[f.account+"_key"][strconv.Itoa(tt.asn)] != tt.wantASNCount {
				t.Errorf("baseline = events:%d ASNs:%v, want events:%d ASN count:%d", seen, asns, tt.wantLearned, tt.wantASNCount)
			}
			next := f.handle(f.send(at.Add(10*time.Minute), 16509, "stripe.com"))
			if next.Score != 20 || len(next.Hits) != 1 || next.Hits[0].Name != "recent_account_change" {
				t.Errorf("send after change = score:%d hits:%+v, want recent_account_change/20", next.Score, next.Hits)
			}
		})
	}
}
func TestServiceConcurrentEventsOnOneAccount(t *testing.T) {
	tests := []struct {
		name    string
		workers int
	}{
		{
			name:    "single event control",
			workers: 1,
		},
		{
			name:    "twenty simultaneous events do not lose updates",
			workers: 20,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			events := make([]*event.Event, tt.workers)
			for i := range events {
				events[i] = f.send(now.Add(time.Duration(i)*time.Second), 16509, "stripe.com")
			}
			var group sync.WaitGroup
			errs := make(chan error, tt.workers)
			for _, ev := range events {
				group.Go(func() {
					if _, err := f.svc.Handle(context.Background(), ev); err != nil {
						errs <- err
					}
				})
			}
			group.Wait()
			close(errs)
			for err := range errs {
				t.Error(err)
			}
			if seen, _, _ := f.profileRow(); seen != tt.workers {
				t.Errorf("learned events = %d, want %d", seen, tt.workers)
			}
		})
	}
}
