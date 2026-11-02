// Package event defines the events posted to /v1/events, their validation,
// and the in-memory feature extraction that lets us discard email bodies.
package event

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"slices"
	"time"
)

const (
	TypeEmailSend     = "email.send"
	TypeAccountChange = "account.change"
	TypeAPIRead       = "api.read"
)

var (
	types       = []string{TypeEmailSend, TypeAccountChange, TypeAPIRead}
	sources     = []string{"api", "smtp", "dashboard"}
	changeKinds = []string{"api_key.created", "api_key.deleted", "team_member.added",
		"webhook.created", "webhook.updated", "webhook.deleted", "domain.updated"}
	readResources = []string{"contacts", "audiences", "domains", "emails", "api_keys", "webhooks"}
)

type Event struct {
	EventID    string    `json:"event_id"`
	Type       string    `json:"type"`
	OccurredAt time.Time `json:"occurred_at"`
	AccountID  string    `json:"account_id"`
	APIKeyID   string    `json:"api_key_id"`
	Source     string    `json:"source"`
	Network    Network   `json:"network"`
	Client     Client    `json:"client"`
	Email      *Email    `json:"email,omitempty"`
	Change     *Change   `json:"change,omitempty"`
	Read       *Read     `json:"read,omitempty"`
}

type Network struct {
	IP     string `json:"ip"`
	ASN    int    `json:"asn"`
	ASNOrg string `json:"asn_org"`
}

type Client struct {
	UserAgent string `json:"user_agent"`
}

type Email struct {
	From    string            `json:"from"`
	To      StringList        `json:"to"`
	CC      StringList        `json:"cc"`
	BCC     StringList        `json:"bcc"`
	ReplyTo StringList        `json:"reply_to"`
	Headers map[string]string `json:"headers"`
	HTML    string            `json:"html"`
	Text    string            `json:"text"`
}

type Change struct {
	Kind     string `json:"kind"`
	TargetID string `json:"target_id"`
}

type Read struct {
	Resource string `json:"resource"`
	Status   int    `json:"status"`
}

// StringList accepts either a JSON string or an array of strings, like Resend's own API.
type StringList []string

func (l *StringList) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*l = nil
		return nil
	}
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*l = StringList{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return errors.New("must be a string or an array of strings")
	}
	*l = many
	return nil
}

func reqField(ok bool, field string) error {
	if ok {
		return nil
	}
	return fmt.Errorf("%s is required", field)
}

func oneOfField(v string, allowed []string, field string) error {
	if slices.Contains(allowed, v) {
		return nil
	}
	return fmt.Errorf("%s must be one of %v", field, allowed)
}

// Validate checks required fields. The error message is safe to return to the caller.
func (e *Event) Validate() error {
	errs := []error{
		reqField(e.EventID != "", "event_id"),
		oneOfField(e.Type, types, "type"),
		reqField(!e.OccurredAt.IsZero(), "occurred_at"),
		reqField(e.AccountID != "", "account_id"),
		oneOfField(e.Source, sources, "source"),
	}
	if e.Source == "api" || e.Source == "smtp" {
		errs = append(errs, reqField(e.APIKeyID != "", "api_key_id"))
	}
	if net.ParseIP(e.Network.IP) == nil {
		errs = append(errs, errors.New("network.ip must be a valid IP address"))
	}
	errs = append(errs, reqField(e.Network.ASN > 0, "network.asn"))

	switch e.Type {
	case TypeEmailSend:
		if e.Email == nil {
			errs = append(errs, errors.New("email is required for email.send"))
			break
		}
		errs = append(errs,
			reqField(e.Email.From != "", "email.from"),
			reqField(len(e.Email.To)+len(e.Email.CC)+len(e.Email.BCC) > 0, "at least one recipient"),
		)
	case TypeAccountChange:
		if e.Change == nil {
			errs = append(errs, errors.New("change is required for account.change"))
			break
		}
		errs = append(errs, oneOfField(e.Change.Kind, changeKinds, "change.kind"))
	case TypeAPIRead:
		if e.Read == nil {
			errs = append(errs, errors.New("read is required for api.read"))
			break
		}
		errs = append(errs, oneOfField(e.Read.Resource, readResources, "read.resource"))
		if e.Read.Status < 100 || e.Read.Status > 599 {
			errs = append(errs, errors.New("read.status must be an HTTP status code"))
		}
	}
	return errors.Join(errs...)
}
