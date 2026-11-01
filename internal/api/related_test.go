package api

import (
	"context"
	"fmt"
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

// A key_suspended rejection means the key was already suspended for something
// else; it must not make a shared domain look like campaign infrastructure.
func TestRelatedIgnoresKeySuspendedRejections(t *testing.T) {
	f := newAPIFixture(t)
	ctx := context.Background()
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into events(event_id,type,occurred_at,account_id,api_key_id,source,ip,link_domains)
		values('collateral_evt','email.send',$1,'collateral','collateral_key','api','198.51.100.9',array['github.com'])`, testNow.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	// The rejection's own signals scored 40, above the genuine allow below, so a
	// score tie-break alone would link the "allow" row to the blocked rejection.
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into decisions(event_id,account_id,api_key_id,occurred_at,action,enforced,score,hits,config_version,reason)
		values('collateral_evt','collateral','collateral_key',$1,'block',true,40,'[]','test','key_suspended')`, testNow.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	var allowed string
	if _, err := f.server.Store.Pool.Exec(ctx, `insert into events(event_id,type,occurred_at,account_id,api_key_id,source,ip,link_domains)
		values('collateral_ok','email.send',$1,'collateral','collateral_key','api','198.51.100.9',array['github.com'])`, testNow.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := f.server.Store.Pool.QueryRow(ctx, `insert into decisions(event_id,account_id,api_key_id,occurred_at,action,enforced,score,hits,config_version)
		values('collateral_ok','collateral','collateral_key',$1,'allow',true,0,'[]','test') returning decision_id::text`, testNow.Add(-2*time.Hour)).Scan(&allowed); err != nil {
		t.Fatal(err)
	}
	ev := f.email(testNow, 16509, "github.com")
	ev.Network.IP = "203.0.113.77"
	d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
	for _, r := range f.detail(d.DecisionID).Related {
		if r.Kind == "link_domain" && r.Value == "github.com" {
			if r.Accounts != 1 || r.Stopped != 0 || r.Top[0].WorstAction != "allow" || r.Top[0].DecisionID != allowed {
				t.Errorf("github.com = %+v, want 1 account, 0 stopped, worst action allow linking the allowed decision %s", r, allowed)
			}
			return
		}
	}
	t.Fatal("github.com was not reported as shared with the collateral account")
}

// The panel shows five accounts and expands to the rest, so the API lists more
// than five; before, "+2 more accounts" had nothing behind it.
func TestRelatedListsBeyondFive(t *testing.T) {
	f := newAPIFixture(t)
	for i := 0; i < 7; i++ {
		ev := f.email(testNow.Add(-time.Duration(i+1)*time.Hour), 14061, "invoice-portal.net")
		ev.AccountID, ev.APIKeyID, ev.Network.IP = fmt.Sprintf("other_%d", i), fmt.Sprintf("other_%d_key", i), fmt.Sprintf("198.51.100.%d", 10+i)
		decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
	}
	ev := f.email(testNow, 14061, "invoice-portal.net")
	ev.Network.IP = "203.0.113.99"
	d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
	for _, r := range f.detail(d.DecisionID).Related {
		if r.Kind == "link_domain" {
			if r.Accounts != 7 || len(r.Top) != 7 {
				t.Errorf("link domain lists %d of %d accounts, want all 7", len(r.Top), r.Accounts)
			}
			return
		}
	}
	t.Fatal("invoice-portal.net was not reported as shared")
}

func TestDecisionIncludesCurrentKeyStatus(t *testing.T) {
	f := newAPIFixture(t)
	d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, f.email(testNow, 16509, "stripe.com")))
	type withKey struct {
		Key *store.KeyStatus `json:"key"`
	}
	if got := decodeResponse[withKey](t, f.get("/v1/decisions/"+d.DecisionID)); got.Key != nil {
		t.Errorf("key = %+v, want null for a key that was never suspended", got.Key)
	}
	if _, err := f.server.Store.Pool.Exec(context.Background(), `insert into key_status(api_key_id,account_id,status,reason) values('key','account','suspended','analyst')`); err != nil {
		t.Fatal(err)
	}
	if got := decodeResponse[withKey](t, f.get("/v1/decisions/"+d.DecisionID)); got.Key == nil || got.Key.Status != "suspended" {
		t.Errorf("key = %+v, want the suspended key", got.Key)
	}
}
