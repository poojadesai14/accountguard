package api

import (
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/store"
)

func TestDecisionRelatedIndicators(t *testing.T) {
	f := newAPIFixture(t)
	// send posts an event for another account and returns its decision id.
	send := func(account, ip string, at time.Time, domain string, replyTo ...string) string {
		t.Helper()
		ev := f.email(at, 14061, domain)
		ev.AccountID, ev.APIKeyID, ev.Network.IP = account, account+"_key", ip
		ev.Email.ReplyTo = event.StringList(replyTo)
		d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
		if d.Unscored {
			t.Fatalf("%s was not scored", ev.EventID)
		}
		return d.DecisionID
	}

	confirmed := send("other_confirmed", "198.51.100.1", testNow.Add(-2*time.Hour), "invoice-portal.net")
	requireStatus(t, f.action(confirmed, "confirm_takeover"), 200)
	send("other_unconfirmed", "198.51.100.2", testNow.Add(time.Hour), "invoice-portal.net", "billing@invoice-portal.net")
	send("other_old", "198.51.100.3", testNow.Add(-30*24*time.Hour), "invoice-portal.net")         // outside the window
	send("other_same_ip", "203.0.113.50", testNow.Add(-time.Hour), "stripe.com")                   // IP only
	send("other_freemail", "198.51.100.4", testNow.Add(-time.Hour), "stripe.com", "ops@gmail.com") // freemail is ignored
	send("account", "198.51.100.5", testNow.Add(-time.Hour), "invoice-portal.net")                 // same account is ignored

	id := send("account", "203.0.113.50", testNow, "invoice-portal.net", "help@invoice-portal.net", "me@gmail.com")
	byIndicator := map[string]store.RelatedIndicator{}
	for _, r := range f.detail(id).Related {
		byIndicator[r.Kind+" "+r.Value] = r
	}

	link := byIndicator["link_domain invoice-portal.net"]
	if link.Accounts != 2 || link.Confirmed != 1 || len(link.Top) != 2 ||
		link.Top[0].AccountID != "other_confirmed" || !link.Top[0].Confirmed || link.Top[0].DecisionID != confirmed {
		t.Errorf("link domain = %+v, want 2 accounts in the window, confirmed takeover first", link)
	}
	if r := byIndicator["reply_to_domain invoice-portal.net"]; r.Accounts != 1 || r.Top[0].AccountID != "other_unconfirmed" {
		t.Errorf("reply-to domain = %+v, want other_unconfirmed only", r)
	}
	if r := byIndicator["ip 203.0.113.50"]; r.Accounts != 1 || r.Top[0].AccountID != "other_same_ip" {
		t.Errorf("ip = %+v, want other_same_ip only", r)
	}
	if _, ok := byIndicator["reply_to_domain gmail.com"]; ok {
		t.Error("freemail Reply-To domain should not be matched across accounts")
	}
	if len(byIndicator) != 3 {
		t.Errorf("indicators = %v, want link domain, reply-to domain and IP", byIndicator)
	}
}
