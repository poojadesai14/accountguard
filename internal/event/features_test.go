package event

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func sendEvent(e *Email) *Event {
	return &Event{Type: TypeEmailSend, Email: e}
}

func TestExtract(t *testing.T) {
	tests := []struct {
		name           string
		event          *Event
		want           Features
		wantCandidates []string
	}{
		{
			name: "email normalizes all content domains and counts every recipient",
			event: sendEvent(&Email{
				From:    "Acme Billing <billing@mail.acme.com>",
				To:      StringList{"a@example.org", "B <b@sub.example.org>"},
				CC:      StringList{"c@other.net"},
				BCC:     StringList{"d@other.net"},
				ReplyTo: StringList{"support@acme.com"},
				Headers: map[string]string{"reply-to": "Help <help@helpdesk.zendesk.com>, x@gmail.com"},
				HTML: `<p>Pay <a href="https://Pay.Invoice-Portal.net/x?y=1">here</a>
		       <img src="//cdn.acme.com/logo.png"> <a href="/relative">r</a>
		       <a href="mailto:billing@acme-secure.com?subject=hi">mail</a>
		       Visit www.evil.co.uk, or write to boss@ceo-mail.com.</p>`,
				Text: "Plain https://bit.ly/abc).",
			}),
			want:           Features{SenderDomain: "acme.com", RecipientCount: 4, LinkDomains: []string{"bit.ly", "evil.co.uk", "invoice-portal.net"}, ReplyToDomains: []string{"gmail.com", "zendesk.com"}, BodyEmailDomains: []string{"acme-secure.com", "ceo-mail.com"}},
			wantCandidates: []string{"acme-secure.com", "bit.ly", "ceo-mail.com", "evil.co.uk", "gmail.com", "invoice-portal.net", "zendesk.com"},
		},
		{
			name:  "account changes have no email features",
			event: &Event{Type: TypeAccountChange},
		},
		{
			name:  "missing email has no features",
			event: &Event{Type: TypeEmailSend},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Extract(tt.event)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Extract() = %+v, want %+v", got, tt.want)
			}
			if candidates := got.Candidates(); !slices.Equal(candidates, tt.wantCandidates) {
				t.Errorf("Candidates() = %v, want %v", candidates, tt.wantCandidates)
			}
		})
	}
}

func TestRegistrable(t *testing.T) {
	tests := []struct{ name, input, want string }{
		{
			name:  "subdomain",
			input: "app.acme.com",
			want:  "acme.com",
		},
		{
			name:  "case and trailing dot",
			input: "ACME.COM.",
			want:  "acme.com",
		},
		{
			name:  "multi-part public suffix",
			input: "a.b.acme.co.uk",
			want:  "acme.co.uk",
		},
		{
			name:  "IP address",
			input: "203.0.113.9",
			want:  "",
		},
		{
			name:  "local hostname",
			input: "localhost",
			want:  "",
		},
		{
			name:  "empty hostname",
			input: "",
			want:  "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Registrable(tt.input); got != tt.want {
				t.Errorf("Registrable(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestStringListAcceptsStringOrArray(t *testing.T) {
	tests := []struct {
		name, input             string
		wantTo, wantCC, wantBCC StringList
	}{
		{
			name:   "mixed strings arrays and null",
			input:  `{"to":"a@x.com","cc":["b@x.com","c@x.com"],"bcc":null}`,
			wantTo: StringList{"a@x.com"},
			wantCC: StringList{"b@x.com", "c@x.com"},
		},
		{
			name:   "recipient array",
			input:  `{"to":["a@x.com","b@x.com"]}`,
			wantTo: StringList{"a@x.com", "b@x.com"},
		},
		{
			name:  "null lists",
			input: `{"to":null,"cc":null,"bcc":null}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got Email
			if err := json.Unmarshal([]byte(tt.input), &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.To, tt.wantTo) || !reflect.DeepEqual(got.CC, tt.wantCC) || !reflect.DeepEqual(got.BCC, tt.wantBCC) {
				t.Errorf("recipient lists = to:%v cc:%v bcc:%v, want to:%v cc:%v bcc:%v", got.To, got.CC, got.BCC, tt.wantTo, tt.wantCC, tt.wantBCC)
			}
		})
	}
}

func TestValidate(t *testing.T) {
	ok := Event{
		EventID: "e1", Type: TypeEmailSend, OccurredAt: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC), AccountID: "a", APIKeyID: "k",
		Source: "api", Network: Network{IP: "203.0.113.9", ASN: 16509},
		Email: &Email{From: "x@acme.com", To: StringList{"y@z.com"}},
	}
	tests := []struct {
		name    string
		mutate  func(e *Event)
		wantErr string
	}{
		{
			name: "valid email event",
		},
		{
			name:    "no event_id",
			mutate:  func(e *Event) { e.EventID = "" },
			wantErr: "event_id is required",
		},
		{
			name:    "bad type",
			mutate:  func(e *Event) { e.Type = "email.sent" },
			wantErr: "type must be one of",
		},
		{
			name:    "api source needs key",
			mutate:  func(e *Event) { e.APIKeyID = "" },
			wantErr: "api_key_id is required",
		},
		{
			name:    "bad ip",
			mutate:  func(e *Event) { e.Network.IP = "nope" },
			wantErr: "network.ip",
		},
		{
			name:    "no asn",
			mutate:  func(e *Event) { e.Network.ASN = 0 },
			wantErr: "network.asn",
		},
		{
			name:    "no recipients",
			mutate:  func(e *Event) { e.Email.To = nil },
			wantErr: "at least one recipient",
		},
		{
			name:    "change missing",
			mutate:  func(e *Event) { e.Type = TypeAccountChange },
			wantErr: "change is required",
		},
		{
			name: "read bad resource",
			mutate: func(e *Event) {
				e.Type = TypeAPIRead
				e.Read = &Read{Resource: "x", Status: 200}
			},
			wantErr: "read.resource",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := ok
			em := *ok.Email
			e.Email = &em
			if tt.mutate != nil {
				tt.mutate(&e)
			}
			err := e.Validate()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("valid event rejected: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}
