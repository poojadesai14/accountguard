// Package profile is the per-account baseline: running summaries, never raw history.
// Signals compare against it first; only then is it updated (SPEC §5.3).
package profile

import (
	"slices"
	"sort"
	"strconv"
	"time"

	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/event"
)

type Profile struct {
	AccountID            string                    `json:"account_id"`
	FirstSeenAt          time.Time                 `json:"first_seen_at"`
	EventsSeen           int                       `json:"events_seen"`   // allowed events folded into the baseline
	KeyASNs              map[string]map[string]int `json:"key_asns"`      // key id -> ASN -> allowed events
	KnownDomains         map[string]int            `json:"known_domains"` // content domain -> allowed sends using it
	SenderDomains        []string                  `json:"sender_domains"`
	UsedFreemailReplyTo  bool                      `json:"used_freemail_reply_to"`
	HourlyEWMA           float64                   `json:"hourly_ewma"` // recipients per active hour
	ActiveHours          int                       `json:"active_hours"`
	HourBucketStart      *time.Time                `json:"hour_bucket_start"`
	HourBucketRecipients int                       `json:"hour_bucket_recipients"`
	ReadResources        []string                  `json:"read_resources"`
	LastChangeAt         *time.Time                `json:"last_change_at"`     // set on every account.change, whatever the decision
	LastFirstReadAt      *time.Time                `json:"last_first_read_at"` // set on every first-ever recon read, whatever the decision
}

func New(accountID string, firstSeen time.Time) *Profile {
	p := &Profile{AccountID: accountID, FirstSeenAt: firstSeen}
	p.Normalize()
	return p
}

// Normalize replaces nil maps and slices so the profile can be updated and saved safely.
func (p *Profile) Normalize() {
	if p.KeyASNs == nil {
		p.KeyASNs = map[string]map[string]int{}
	}
	if p.KnownDomains == nil {
		p.KnownDomains = map[string]int{}
	}
	if p.SenderDomains == nil {
		p.SenderDomains = []string{}
	}
	if p.ReadResources == nil {
		p.ReadResources = []string{}
	}
}

// ColdStart is true while history-based signals must stay quiet.
func (p *Profile) ColdStart(cfg *config.Config) bool {
	return p.EventsSeen < cfg.Baseline.MinEvents
}

// KnownASN reports whether asn is normal for key. Keys with little history are compared
// against the whole account so a new key isn't automatically a "new network".
// scope describes what was compared, for the hit detail.
func (p *Profile) KnownASN(key string, asn int, cfg *config.Config) (known bool, scope string) {
	a := strconv.Itoa(asn)
	if p.KeyEvents(key) >= cfg.Network.MinKeyEvents {
		_, known = p.KeyASNs[key][a]
		return known, "key " + key
	}
	for _, m := range p.KeyASNs {
		if _, ok := m[a]; ok {
			return true, "account"
		}
	}
	return false, "account"
}

// KeyEvents is how many allowed events this key has: the sum over its ASNs.
func (p *Profile) KeyEvents(key string) int {
	n := 0
	for _, c := range p.KeyASNs[key] {
		n += c
	}
	return n
}

// IsFirstRead is true when ev is the account's first-ever read of a recon resource.
func (p *Profile) IsFirstRead(ev *event.Event, cfg *config.Config) bool {
	return ev.Type == event.TypeAPIRead && ev.Read != nil &&
		slices.Contains(cfg.Account.ReconResources, ev.Read.Resource) &&
		!slices.Contains(p.ReadResources, ev.Read.Resource)
}

// RecordAlways applies updates that happen whatever the decision, so an attacker
// can't hide account changes or recon by getting held.
func (p *Profile) RecordAlways(ev *event.Event, cfg *config.Config) {
	t := ev.OccurredAt
	switch ev.Type {
	case event.TypeAccountChange:
		p.LastChangeAt = &t
	case event.TypeAPIRead:
		if p.IsFirstRead(ev, cfg) {
			p.LastFirstReadAt = &t
		}
		if ev.Read != nil && !slices.Contains(p.ReadResources, ev.Read.Resource) {
			p.ReadResources = append(p.ReadResources, ev.Read.Resource)
		}
	}
}

// Learn folds an event into the baseline. Call it only for allowed events, or when an
// analyst or owner marks an event legitimate; otherwise the attacker trains the baseline.
func (p *Profile) Learn(ev *event.Event, f event.Features, cfg *config.Config) {
	p.EventsSeen++
	if key := ev.APIKeyID; key != "" {
		if p.KeyASNs[key] == nil {
			p.KeyASNs[key] = map[string]int{}
		}
		p.KeyASNs[key][strconv.Itoa(ev.Network.ASN)]++
	}
	if ev.Type != event.TypeEmailSend {
		return
	}

	for _, d := range f.Candidates() {
		p.KnownDomains[d]++
	}
	p.trimKnownDomains(cfg.Baseline.MaxKnownDomains)
	if f.SenderDomain != "" && !slices.Contains(p.SenderDomains, f.SenderDomain) {
		p.SenderDomains = append(p.SenderDomains, f.SenderDomain)
	}
	for _, d := range f.ReplyToDomains {
		if cfg.Content.Freemail[d] {
			p.UsedFreemailReplyTo = true
		}
	}
	p.addRecipients(ev.OccurredAt, f.RecipientCount, cfg.Velocity.EWMAAlpha)
}

// addRecipients keeps one open hour bucket; when an event lands in a later hour, the old bucket
// is folded into the EWMA. Hours with no sends are skipped, so the baseline means
// "recipients per hour while this account is sending".
func (p *Profile) addRecipients(t time.Time, n int, alpha float64) {
	h := t.UTC().Truncate(time.Hour)
	switch {
	case p.HourBucketStart == nil:
		p.HourBucketStart = &h
		p.HourBucketRecipients = n
	case h.After(*p.HourBucketStart):
		old := float64(p.HourBucketRecipients)
		if p.ActiveHours == 0 {
			p.HourlyEWMA = old
		} else {
			p.HourlyEWMA = alpha*old + (1-alpha)*p.HourlyEWMA
		}
		p.ActiveHours++
		p.HourBucketStart = &h
		p.HourBucketRecipients = n
	default: // same hour, or a late event for an earlier hour
		p.HourBucketRecipients += n
	}
}

func (p *Profile) trimKnownDomains(max int) {
	if len(p.KnownDomains) <= max {
		return
	}
	type kv struct {
		d string
		n int
	}
	all := make([]kv, 0, len(p.KnownDomains))
	for d, n := range p.KnownDomains {
		all = append(all, kv{d, n})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].n != all[j].n {
			return all[i].n < all[j].n
		}
		return all[i].d < all[j].d
	})
	for _, e := range all[:len(all)-max] {
		delete(p.KnownDomains, e.d)
	}
}
