package profile

import (
	"math"
	"reflect"
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
	return &event.Event{Type: event.TypeEmailSend, OccurredAt: at, APIKeyID: "k1", Network: event.Network{ASN: 16509}}, event.Features{SenderDomain: "acme.com", RecipientCount: recipients, LinkDomains: []string{"stripe.com"}}
}
func TestHourlyEWMA(t *testing.T) {
	type delivery struct {
		after      time.Duration
		recipients int
	}
	tests := []struct {
		name                 string
		deliveries           []delivery
		wantHours            int
		wantEWMA             float64
		wantBucketAfter      time.Duration
		wantBucketRecipients int
	}{
		{
			name: "same-hour sends remain in the open bucket",
			deliveries: []delivery{{
				after:      0,
				recipients: 10,
			}, {
				after:      30 * time.Minute,
				recipients: 30,
			}},
			wantHours:            0,
			wantEWMA:             0,
			wantBucketAfter:      0,
			wantBucketRecipients: 40,
		},
		{
			name: "first completed hour establishes the baseline",
			deliveries: []delivery{{
				after:      0,
				recipients: 10,
			}, {
				after:      30 * time.Minute,
				recipients: 30,
			}, {
				after:      time.Hour,
				recipients: 20,
			}},
			wantHours:            1,
			wantEWMA:             40,
			wantBucketAfter:      time.Hour,
			wantBucketRecipients: 20,
		},
		{
			name: "empty hours are skipped when updating EWMA",
			deliveries: []delivery{{
				after:      0,
				recipients: 10,
			}, {
				after:      30 * time.Minute,
				recipients: 30,
			}, {
				after:      time.Hour,
				recipients: 20,
			}, {
				after:      4 * time.Hour,
				recipients: 5,
			}},
			wantHours:            2,
			wantEWMA:             38,
			wantBucketAfter:      4 * time.Hour,
			wantBucketRecipients: 5,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testConfig(t)
			start := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
			p := New("a", start)
			for _, delivery := range tt.deliveries {
				ev, features := send(start.Add(delivery.after), delivery.recipients)
				p.Learn(ev, features, cfg)
			}
			if p.ActiveHours != tt.wantHours {
				t.Errorf("active hours = %d, want %d", p.ActiveHours, tt.wantHours)
			}
			if math.Abs(p.HourlyEWMA-tt.wantEWMA) > 1e-9 {
				t.Errorf("hourly EWMA = %v, want %v", p.HourlyEWMA, tt.wantEWMA)
			}
			if p.HourBucketStart == nil || !p.HourBucketStart.Equal(start.Add(tt.wantBucketAfter)) {
				t.Errorf("open bucket starts at %v, want %v", p.HourBucketStart, start.Add(tt.wantBucketAfter))
			}
			if p.HourBucketRecipients != tt.wantBucketRecipients {
				t.Errorf("open bucket recipients = %d, want %d", p.HourBucketRecipients, tt.wantBucketRecipients)
			}
			wantEvents := len(tt.deliveries)
			if p.EventsSeen != wantEvents || p.KeyASNs["k1"]["16509"] != wantEvents || p.KnownDomains["stripe.com"] != wantEvents {
				t.Errorf("learned counts = events:%d ASN:%d domain:%d, want %d each", p.EventsSeen, p.KeyASNs["k1"]["16509"], p.KnownDomains["stripe.com"], wantEvents)
			}
		})
	}
}
func TestRecordAlwaysTracksChangesAndFirstReads(t *testing.T) {
	at := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	contacts := event.Event{Type: event.TypeAPIRead, OccurredAt: at, Read: &event.Read{Resource: "contacts", Status: 403}}
	emails := event.Event{Type: event.TypeAPIRead, OccurredAt: at.Add(time.Hour), Read: &event.Read{Resource: "emails", Status: 200}}
	change := event.Event{Type: event.TypeAccountChange, OccurredAt: at, Change: &event.Change{Kind: "api_key.created"}}
	tests := []struct {
		name                              string
		events                            []event.Event
		wantFirstRead                     []bool
		wantLastFirstRead, wantLastChange *time.Time
	}{
		{
			name:              "first denied recon read is still recorded",
			events:            []event.Event{contacts},
			wantFirstRead:     []bool{true},
			wantLastFirstRead: &at,
		},
		{
			name:              "repeated recon read is not first again",
			events:            []event.Event{contacts, contacts},
			wantFirstRead:     []bool{true, false},
			wantLastFirstRead: &at,
		},
		{
			name:              "non-recon read does not move the first-read timestamp",
			events:            []event.Event{contacts, emails},
			wantFirstRead:     []bool{true, false},
			wantLastFirstRead: &at,
		},
		{
			name:              "account changes and recon are tracked without learning",
			events:            []event.Event{contacts, emails, change},
			wantFirstRead:     []bool{true, false, false},
			wantLastFirstRead: &at,
			wantLastChange:    &at,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testConfig(t)
			p := New("a", at.AddDate(-1, 0, 0))
			for i, ev := range tt.events {
				if got := p.IsFirstRead(&ev, cfg); got != tt.wantFirstRead[i] {
					t.Errorf("event %d first-read = %v, want %v", i, got, tt.wantFirstRead[i])
				}
				p.RecordAlways(&ev, cfg)
				if p.IsFirstRead(&ev, cfg) {
					t.Errorf("event %d remains a first read after recording", i)
				}
			}
			if !reflect.DeepEqual(p.LastFirstReadAt, tt.wantLastFirstRead) {
				t.Errorf("last first-read = %v, want %v", p.LastFirstReadAt, tt.wantLastFirstRead)
			}
			if !reflect.DeepEqual(p.LastChangeAt, tt.wantLastChange) {
				t.Errorf("last change = %v, want %v", p.LastChangeAt, tt.wantLastChange)
			}
			if p.EventsSeen != 0 {
				t.Errorf("RecordAlways learned %d events, want zero", p.EventsSeen)
			}
		})
	}
}
func TestKnownASNFallsBackToAccountForNewKeys(t *testing.T) {
	tests := []struct {
		name, key string
		asn       int
		wantKnown bool
		wantScope string
	}{
		{
			name:      "new key uses account history",
			key:       "new",
			asn:       16509,
			wantKnown: true,
			wantScope: "account",
		},
		{
			name:      "established key recognizes its ASN",
			key:       "old",
			asn:       16509,
			wantKnown: true,
			wantScope: "key old",
		},
		{
			name:      "established key rejects unseen ASN",
			key:       "old",
			asn:       14061,
			wantKnown: false,
			wantScope: "key old",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testConfig(t)
			p := New("a", time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC))
			p.KeyASNs["old"] = map[string]int{"16509": 500}
			known, scope := p.KnownASN(tt.key, tt.asn, cfg)
			if known != tt.wantKnown || scope != tt.wantScope {
				t.Errorf("KnownASN(%q, %d) = %v, %q; want %v, %q", tt.key, tt.asn, known, scope, tt.wantKnown, tt.wantScope)
			}
		})
	}
}
func TestTrimKnownDomains(t *testing.T) {
	tests := []struct {
		name    string
		domains map[string]int
		limit   int
		want    map[string]int
	}{
		{
			name:    "least-used domain is removed",
			domains: map[string]int{"a.com": 1, "b.com": 5, "c.com": 3},
			limit:   2,
			want:    map[string]int{"b.com": 5, "c.com": 3},
		},
		{
			name:    "within limit keeps all domains",
			domains: map[string]int{"a.com": 1, "b.com": 5},
			limit:   2,
			want:    map[string]int{"a.com": 1, "b.com": 5},
		},
		{
			name:    "frequency ties are resolved by name",
			domains: map[string]int{"a.com": 1, "b.com": 1, "c.com": 1},
			limit:   2,
			want:    map[string]int{"b.com": 1, "c.com": 1},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := New("a", time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC))
			p.KnownDomains = tt.domains
			p.trimKnownDomains(tt.limit)
			if !reflect.DeepEqual(p.KnownDomains, tt.want) {
				t.Errorf("known domains = %v, want %v", p.KnownDomains, tt.want)
			}
		})
	}
}
