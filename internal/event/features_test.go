package event

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func sendEvent(e *Email) *Event {
	return &Event{Type: TypeEmailSend, Email: e}
}

func TestExtract(t *testing.T) {
	f := Extract(sendEvent(&Email{
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
		Text:        "Plain https://bit.ly/abc).",
		Attachments: []Attachment{{Filename: "Invoice.PDF"}, {Filename: "x.html"}},
	}))

	want := Features{
		SenderDomain:     "acme.com",
		RecipientCount:   4,
		RecipientDomains: []string{"example.org", "other.net"},
		LinkDomains:      []string{"bit.ly", "evil.co.uk", "invoice-portal.net"},
		ReplyToDomains:   []string{"gmail.com", "zendesk.com"},
		BodyEmailDomains: []string{"acme-secure.com", "ceo-mail.com"},
		AttachmentExts:   []string{"html", "pdf"},
	}
	if !reflect.DeepEqual(f, want) {
		t.Errorf("got  %+v\nwant %+v", f, want)
	}
	if got := f.Candidates(); !reflect.DeepEqual(got, []string{
		"acme-secure.com", "bit.ly", "ceo-mail.com", "evil.co.uk", "gmail.com", "invoice-portal.net", "zendesk.com",
	}) {
		t.Errorf("candidates = %v", got)
	}
}

func TestRegistrable(t *testing.T) {
	for in, want := range map[string]string{
		"app.acme.com":   "acme.com",
		"ACME.COM.":      "acme.com",
		"a.b.acme.co.uk": "acme.co.uk",
		"203.0.113.9":    "",
		"localhost":      "",
		"":               "",
	} {
		if got := Registrable(in); got != want {
			t.Errorf("Registrable(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStringListAcceptsStringOrArray(t *testing.T) {
	var e Email
	if err := json.Unmarshal([]byte(`{"to":"a@x.com","cc":["b@x.com","c@x.com"],"bcc":null}`), &e); err != nil {
		t.Fatal(err)
	}
	if len(e.To) != 1 || len(e.CC) != 2 || e.BCC != nil {
		t.Errorf("to=%v cc=%v bcc=%v", e.To, e.CC, e.BCC)
	}
}

func TestValidate(t *testing.T) {
	ok := Event{
		EventID: "e1", Type: TypeEmailSend, OccurredAt: time.Now(), AccountID: "a", APIKeyID: "k",
		Source: "api", Network: Network{IP: "203.0.113.9", ASN: 16509},
		Email: &Email{From: "x@acme.com", To: StringList{"y@z.com"}},
	}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid event rejected: %v", err)
	}

	tests := []struct {
		name    string
		mutate  func(e *Event)
		wantErr string
	}{
		{"no event_id", func(e *Event) { e.EventID = "" }, "event_id is required"},
		{"bad type", func(e *Event) { e.Type = "email.sent" }, "type must be one of"},
		{"api source needs key", func(e *Event) { e.APIKeyID = "" }, "api_key_id is required"},
		{"bad ip", func(e *Event) { e.Network.IP = "nope" }, "network.ip"},
		{"no asn", func(e *Event) { e.Network.ASN = 0 }, "network.asn"},
		{"no recipients", func(e *Event) { e.Email.To = nil }, "at least one recipient"},
		{"change missing", func(e *Event) { e.Type = TypeAccountChange }, "change is required"},
		{"read bad resource", func(e *Event) { e.Type = TypeAPIRead; e.Read = &Read{Resource: "x", Status: 200} }, "read.resource"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := ok
			em := *ok.Email
			e.Email = &em
			tt.mutate(&e)
			err := e.Validate()
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}
