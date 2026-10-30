package profile

import (
	"math"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/event"
)

func testConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg, err := config.Load("../../config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func send(at time.Time, recipients int) (*event.Event, event.Features) {
	return &event.Event{Type: event.TypeEmailSend, OccurredAt: at, APIKeyID: "k1", Network: event.Network{ASN: 16509}},
		event.Features{SenderDomain: "acme.com", RecipientCount: recipients, LinkDomains: []string{"stripe.com"}}
}

func TestHourlyEWMA(t *testing.T) {
	cfg := testConfig(t)
	t0 := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	p := New("a", t0)

	// Hour 1: 10 + 30 = 40. Hour 2: 20. Hour 5 (gap skipped): 5 (still open).
	for _, s := range []struct {
		at time.Duration
		n  int
	}{{0, 10}, {30 * time.Minute, 30}, {time.Hour, 20}, {4 * time.Hour, 5}} {
		ev, f := send(t0.Add(s.at), s.n)
		p.Learn(ev, f, cfg)
	}

	// first fold: ewma = 40; second fold: 0.1*20 + 0.9*40 = 38
	if p.ActiveHours != 2 || math.Abs(p.HourlyEWMA-38) > 1e-9 {
		t.Errorf("active_hours=%d ewma=%v, want 2 and 38", p.ActiveHours, p.HourlyEWMA)
	}
	if p.HourBucketRecipients != 5 || !p.HourBucketStart.Equal(t0.Add(4*time.Hour)) {
		t.Errorf("open bucket = %v/%d", p.HourBucketStart, p.HourBucketRecipients)
	}
	if p.EventsSeen != 4 || p.KeyASNs["k1"]["16509"] != 4 || p.KnownDomains["stripe.com"] != 4 {
		t.Errorf("counts wrong: %+v", p)
	}
}

func TestRecordAlwaysTracksChangesAndFirstReads(t *testing.T) {
	cfg := testConfig(t)
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	p := New("a", now.AddDate(-1, 0, 0))

	read := &event.Event{Type: event.TypeAPIRead, OccurredAt: now, Read: &event.Read{Resource: "contacts", Status: 403}}
	if !p.IsFirstRead(read, cfg) {
		t.Fatal("first contacts read not detected")
	}
	p.RecordAlways(read, cfg)
	if p.LastFirstReadAt == nil || !p.LastFirstReadAt.Equal(now) {
		t.Error("last_first_read_at not set")
	}
	if p.IsFirstRead(read, cfg) {
		t.Error("second read counted as first")
	}

	emails := &event.Event{Type: event.TypeAPIRead, OccurredAt: now.Add(time.Hour), Read: &event.Read{Resource: "emails", Status: 200}}
	p.RecordAlways(emails, cfg)
	if !p.LastFirstReadAt.Equal(now) {
		t.Error("non-recon resource moved last_first_read_at")
	}

	change := &event.Event{Type: event.TypeAccountChange, OccurredAt: now, Change: &event.Change{Kind: "api_key.created"}}
	p.RecordAlways(change, cfg)
	if p.LastChangeAt == nil {
		t.Error("last_change_at not set")
	}
	if p.EventsSeen != 0 {
		t.Error("RecordAlways must not touch the learned baseline")
	}
}

func TestKnownASNFallsBackToAccountForNewKeys(t *testing.T) {
	cfg := testConfig(t)
	p := New("a", time.Now())
	p.KeyASNs["old"] = map[string]int{"16509": 500}
	p.KeyEvents["old"] = 500

	if known, scope := p.KnownASN("new", 16509, cfg); !known || scope != "account" {
		t.Errorf("new key on account ASN: known=%v scope=%s", known, scope)
	}
	if known, _ := p.KnownASN("old", 14061, cfg); known {
		t.Error("unseen ASN reported known")
	}
}

func TestTrimKnownDomains(t *testing.T) {
	p := New("a", time.Now())
	p.KnownDomains = map[string]int{"a.com": 1, "b.com": 5, "c.com": 3}
	p.trimKnownDomains(2)
	if _, ok := p.KnownDomains["a.com"]; ok || len(p.KnownDomains) != 2 {
		t.Errorf("trim kept %v", p.KnownDomains)
	}
}
