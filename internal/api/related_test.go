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
	if len(byIndicator) != 3 {
		t.Errorf("indicators = %v, want link domain, reply-to domain and IP", byIndicator)
	}

	tests := []struct {
		name          string
		indicator     string
		wantPresent   bool
		wantAccounts  int
		wantConfirmed int
		wantFirst     string // first account listed
		wantDecision  string // its linked decision, when checked
	}{
		{name: "a shared link domain lists the window's accounts, confirmed takeover first", indicator: "link_domain invoice-portal.net",
			wantPresent: true, wantAccounts: 2, wantConfirmed: 1, wantFirst: "other_confirmed", wantDecision: confirmed},
		{name: "a shared non-freemail Reply-To domain", indicator: "reply_to_domain invoice-portal.net",
			wantPresent: true, wantAccounts: 1, wantFirst: "other_unconfirmed"},
		{name: "a shared IP", indicator: "ip 203.0.113.50", wantPresent: true, wantAccounts: 1, wantFirst: "other_same_ip"},
		{name: "a freemail Reply-To domain is never matched", indicator: "reply_to_domain gmail.com", wantPresent: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, ok := byIndicator[tt.indicator]
			if ok != tt.wantPresent {
				t.Fatalf("present = %v, want %v", ok, tt.wantPresent)
			}
			if !ok {
				return
			}
			if r.Accounts != tt.wantAccounts || r.Confirmed != tt.wantConfirmed || len(r.Top) != tt.wantAccounts || r.Top[0].AccountID != tt.wantFirst {
				t.Errorf("%s = %+v, want %d accounts (%d confirmed), %s first", tt.indicator, r, tt.wantAccounts, tt.wantConfirmed, tt.wantFirst)
			}
			if tt.wantDecision != "" && (r.Top[0].DecisionID != tt.wantDecision || !r.Top[0].Confirmed) {
				t.Errorf("first = %+v, want confirmed, linking decision %s", r.Top[0], tt.wantDecision)
			}
		})
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
	var github *store.RelatedIndicator
	for _, r := range f.detail(d.DecisionID).Related {
		if r.Kind == "link_domain" && r.Value == "github.com" {
			github = &r
		}
	}
	if github == nil {
		t.Fatal("github.com was not reported as shared with the collateral account")
	}
	tests := []struct {
		name string
		got  any
		want any
	}{
		{name: "the collateral account is counted once", got: github.Accounts, want: 1},
		{name: "the rejection doesn't count as stopped", got: github.Stopped, want: 0},
		{name: "its worst action is the genuine allow", got: github.Top[0].WorstAction, want: "allow"},
		{name: "it links the allowed decision, not the rejection", got: github.Top[0].DecisionID, want: allowed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.got != tt.want {
				t.Errorf("got %v, want %v", tt.got, tt.want)
			}
		})
	}
}

// The panel shows five accounts and expands to the rest, so the API lists more
// than five; before, "+2 more accounts" had nothing behind it.
func TestRelatedListsBeyondFive(t *testing.T) {
	f := newAPIFixture(t)
	tests := []struct {
		name   string
		others int
	}{
		{name: "one other account", others: 1},
		{name: "exactly the five the panel shows first", others: 5},
		{name: "seven: all listed, so the panel can expand to them", others: 7},
	}
	for c, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Each case shares its own domain from its own IPs.
			domain := fmt.Sprintf("shared-%d.example", c)
			for i := 0; i < tt.others; i++ {
				ev := f.email(testNow.Add(-time.Duration(i+1)*time.Hour), 14061, domain)
				ev.AccountID, ev.APIKeyID = fmt.Sprintf("other_%d_%d", c, i), fmt.Sprintf("other_%d_%d_key", c, i)
				ev.Network.IP = fmt.Sprintf("198.51.%d.%d", 100+c, 10+i)
				decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
			}
			ev := f.email(testNow.Add(time.Duration(c)*time.Minute), 14061, domain)
			ev.Network.IP = fmt.Sprintf("203.0.%d.99", 113+c)
			d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, ev))
			for _, r := range f.detail(d.DecisionID).Related {
				if r.Kind == "link_domain" && r.Value == domain {
					if r.Accounts != tt.others || len(r.Top) != tt.others {
						t.Errorf("lists %d of %d accounts, want all %d", len(r.Top), r.Accounts, tt.others)
					}
					return
				}
			}
			t.Fatalf("%s was not reported as shared", domain)
		})
	}
}

func TestDecisionIncludesCurrentKeyStatus(t *testing.T) {
	f := newAPIFixture(t)
	d := decodeResponse[DecisionResponse](t, request(t, f.handler, "POST", "/v1/events", testIngestToken, f.email(testNow, 16509, "stripe.com")))
	type withKey struct {
		Key *store.KeyStatus `json:"key"`
	}
	// Steps in order: the key's status changes between them.
	tests := []struct {
		name       string
		setup      string // SQL run first, if any
		wantStatus string // empty: no key status at all
	}{
		{name: "a key never suspended has no status", wantStatus: ""},
		{name: "a suspended key is included", setup: `insert into key_status(api_key_id,account_id,status,reason) values('key','account','suspended','analyst')`, wantStatus: "suspended"},
		{name: "a restored key is included as active", setup: `update key_status set status = 'active' where api_key_id = 'key'`, wantStatus: "active"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setup != "" {
				if _, err := f.server.Store.Pool.Exec(context.Background(), tt.setup); err != nil {
					t.Fatal(err)
				}
			}
			got := decodeResponse[withKey](t, f.get("/v1/decisions/"+d.DecisionID)).Key
			switch {
			case tt.wantStatus == "" && got != nil:
				t.Errorf("key = %+v, want null", got)
			case tt.wantStatus != "" && (got == nil || got.Status != tt.wantStatus):
				t.Errorf("key = %+v, want status %s", got, tt.wantStatus)
			}
		})
	}
}
