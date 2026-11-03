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

// Validate checks required fields. The error message is safe to return to the caller.
func (e *Event) Validate() error {
	var errs []error

	if e.EventID == "" {
		errs = append(errs, errors.New("event_id is required"))
	}
	if !slices.Contains(types, e.Type) {
		errs = append(errs, fmt.Errorf("type must be one of %v", types))
	}
	if e.OccurredAt.IsZero() {
		errs = append(errs, errors.New("occurred_at is required"))
	}
	if e.AccountID == "" {
		errs = append(errs, errors.New("account_id is required"))
	}
	if !slices.Contains(sources, e.Source) {
		errs = append(errs, fmt.Errorf("source must be one of %v", sources))
	}
	if (e.Source == "api" || e.Source == "smtp") && e.APIKeyID == "" {
		errs = append(errs, errors.New("api_key_id is required"))
	}
	if net.ParseIP(e.Network.IP) == nil {
		errs = append(errs, errors.New("network.ip must be a valid IP address"))
	}
	if e.Network.ASN <= 0 {
		errs = append(errs, errors.New("network.asn is required"))
	}

	switch e.Type {
	case TypeEmailSend:
		if e.Email == nil {
			errs = append(errs, errors.New("email is required for email.send"))
			break
		}
		if e.Email.From == "" {
			errs = append(errs, errors.New("email.from is required"))
		}
		if len(e.Email.To)+len(e.Email.CC)+len(e.Email.BCC) == 0 {
			errs = append(errs, errors.New("at least one recipient is required"))
		}
	case TypeAccountChange:
		if e.Change == nil {
			errs = append(errs, errors.New("change is required for account.change"))
			break
		}
		if !slices.Contains(changeKinds, e.Change.Kind) {
			errs = append(errs, fmt.Errorf("change.kind must be one of %v", changeKinds))
		}
	case TypeAPIRead:
		if e.Read == nil {
			errs = append(errs, errors.New("read is required for api.read"))
			break
		}
		if !slices.Contains(readResources, e.Read.Resource) {
			errs = append(errs, fmt.Errorf("read.resource must be one of %v", readResources))
		}
		if e.Read.Status < 100 || e.Read.Status > 599 {
			errs = append(errs, errors.New("read.status must be an HTTP status code"))
		}
	}
	return errors.Join(errs...)
}
