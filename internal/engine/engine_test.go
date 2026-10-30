package engine

import (
	"slices"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/profile"
	"github.com/poojadesai14/resend-ato/internal/signal"
)

var now = time.Date(2026, 10, 30, 14, 0, 0, 0, time.UTC)

func testConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg, err := config.Load("../../config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Content.DomainAges["acme-secure.com"] = now.AddDate(0, 0, -3)
	return cfg
}

// established: a year-old account, 1000 allowed sends from AWS on key_prod_1, ~40 recipients/hour.
func established() *profile.Profile {
	p := profile.New("acc_acme", now.AddDate(-1, 0, 0))
	p.EventsSeen = 1000
	p.KeyASNs["key_prod_1"] = map[string]int{"16509": 1000}
	p.KnownDomains = map[string]int{"stripe.com": 500, "twitter.com": 500, "acmecdn.com": 300}
	p.SenderDomains = []string{"acme.com"}
	p.HourlyEWMA = 40
	p.ActiveHours = 500
	return p
}

func sendEv(asn int, html string) *event.Event {
	return &event.Event{
		EventID: "e", Type: event.TypeEmailSend, OccurredAt: now, AccountID: "acc_acme",
		APIKeyID: "key_prod_1", Source: "api", Network: event.Network{IP: "203.0.113.9", ASN: asn},
		Email: &event.Email{From: "billing@acme.com", To: event.StringList{"a@example.org"}, HTML: html},
	}
}

func TestScenarios(t *testing.T) {
	cfg := testConfig(t)
	link := func(d string) string { return `<a href="https://` + d + `/x">x</a>` }

	tests := []struct {
		name       string
		profile    func() *profile.Profile
		event      func() *event.Event
		window     int // recipients in the last hour, including this event
		suspended  bool
		wantHits   []string
		wantScore  int
		wantAction Action
	}{
		{"normal send", established, func() *event.Event { return sendEv(16509, link("stripe.com")) },
			40, false, nil, 0, Allow},
		{"legit campaign", established, func() *event.Event { return sendEv(16509, link("stripe.com")) },
			400, false, []string{"recipient_spike"}, 15, Allow},
		{"infra migration", established, func() *event.Event { return sendEv(14061, link("stripe.com")) },
			40, false, []string{"new_asn"}, 30, Flag},
		{"new key created then used from same network",
			func() *profile.Profile {
				p := established()
				ts := now.Add(-10 * time.Minute)
				p.LastChangeAt = &ts
				return p
			},
			func() *event.Event { e := sendEv(16509, link("stripe.com")); e.APIKeyID = "key_new_7"; return e },
			40, false, []string{"recent_account_change"}, 20, Allow},
		{"recon: first contacts read + new key in 24h",
			func() *profile.Profile { p := established(); ts := now.Add(-time.Hour); p.LastChangeAt = &ts; return p },
			func() *event.Event {
				e := sendEv(16509, "")
				e.Type, e.Email, e.Read = event.TypeAPIRead, nil, &event.Read{Resource: "contacts", Status: 200}
				return e
			},
			0, false, []string{"recent_account_change", "first_read"}, 40, Flag},
		{"takeover: new network + new young link", established,
			func() *event.Event { return sendEv(14061, link("invoice-portal.net")) },
			40, false, []string{"new_asn", "new_domain", "young_domain"}, 75, Hold},
		{"takeover with spike", established,
			func() *event.Event { return sendEv(14061, link("invoice-portal.net")) },
			400, false, []string{"new_asn", "recipient_spike", "new_domain", "young_domain"}, 90, Block},
		{"takeover with young brand-containing link", established,
			func() *event.Event { return sendEv(14061, link("acme-secure.com")) },
			40, false, []string{"new_asn", "new_domain", "young_domain", "lookalike_domain"}, 100, Block},
		{"brand's own known domain", established,
			func() *event.Event { return sendEv(16509, link("acmecdn.com")) },
			40, false, nil, 0, Allow},
		{"new account (3 days) reads contacts",
			func() *profile.Profile { return profile.New("acc_new", now.AddDate(0, 0, -3)) },
			func() *event.Event {
				e := sendEv(16509, "")
				e.Type, e.Email, e.Read = event.TypeAPIRead, nil, &event.Read{Resource: "contacts", Status: 200}
				return e
			},
			0, false, nil, 0, Allow},
		{"clean-history account, young lookalike link",
			func() *profile.Profile {
				p := profile.New("acc_beta", now.AddDate(0, 0, -2))
				p.EventsSeen = 5
				return p
			},
			func() *event.Event {
				e := sendEv(14061, link("betta.io"))
				e.Email.From = "hello@beta.io"
				return e
			},
			5, false, []string{"young_domain", "lookalike_domain"}, 50, Flag},
		{"content only: new + young + lookalike", established,
			func() *event.Event { return sendEv(16509, link("acrne.com")) },
			40, false, []string{"new_domain", "young_domain", "lookalike_domain"}, 75, Hold},
		{"suspended key", established, func() *event.Event { return sendEv(16509, link("stripe.com")) },
			40, true, nil, 0, Block},
		{"cold start: new ASN + spike stay quiet",
			func() *profile.Profile { p := established(); p.EventsSeen = 10; return p },
			func() *event.Event { return sendEv(14061, link("stripe.com")) },
			5000, false, nil, 0, Allow},
		{"free-mail Reply-To (BEC, no links)", established,
			func() *event.Event {
				e := sendEv(16509, "<p>Reply to confirm bank details</p>")
				e.Email.ReplyTo = event.StringList{"ceo.acme@gmail.com"}
				return e
			},
			40, false, []string{"new_domain", "freemail_reply_to"}, 40, Flag},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ev := tt.event()
			in := &signal.Input{
				Event: ev, Features: event.Extract(ev), Profile: tt.profile(),
				WindowRecipients: tt.window, Config: cfg,
			}
			res := Evaluate(in, tt.suspended)

			var got []string
			for _, h := range res.Hits {
				got = append(got, h.Name)
			}
			if !slices.Equal(got, tt.wantHits) {
				t.Errorf("hits = %v, want %v", got, tt.wantHits)
			}
			if res.Score != tt.wantScore || res.Action != tt.wantAction {
				t.Errorf("score/action = %d/%s, want %d/%s (hits %+v)", res.Score, res.Action, tt.wantScore, tt.wantAction, res.Hits)
			}
			if tt.suspended && res.Reason != ReasonKeySuspended {
				t.Errorf("reason = %q, want key_suspended", res.Reason)
			}
		})
	}
}

func TestDecideRules(t *testing.T) {
	cfg := testConfig(t)
	h := func(cat string, pts int) signal.Hit { return signal.Hit{Name: cat, Category: cat, Points: pts} }

	tests := []struct {
		name   string
		hits   []signal.Hit
		hasKey bool
		want   Action
	}{
		{"two categories at 90 block", []signal.Hit{h("network", 50), h("account", 40)}, true, Block},
		{"one non-content category capped at flag", []signal.Hit{h("velocity", 90)}, true, Flag},
		{"content alone holds, never blocks", []signal.Hit{h("content", 95)}, true, Hold},
		{"no key caps at hold", []signal.Hit{h("network", 50), h("content", 40)}, false, Hold},
		{"score capped at max", []signal.Hit{h("network", 80), h("content", 80)}, true, Block},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			score, got, _ := Decide(tt.hits, false, tt.hasKey, cfg)
			if got != tt.want || score > cfg.Scoring.MaxScore {
				t.Errorf("action = %s score = %d, want %s", got, score, tt.want)
			}
		})
	}
}
