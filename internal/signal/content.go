package signal

import (
	"fmt"
	"strings"
	"time"

	"github.com/poojadesai14/accountguard/internal/event"
	"golang.org/x/net/publicsuffix"
)

// evalContent checks link, Reply-To and body-address domains. Each hit fires at most once per event.
// new_domain and freemail_reply_to need history; young_domain and lookalike_domain don't.
func evalContent(in *Input) []Hit {
	ev, f, p, cfg := in.Event, in.Features, in.Profile, in.Config
	if ev.Type != event.TypeEmailSend {
		return nil
	}
	cold := p.ColdStart(cfg)

	brands := map[string]bool{}
	if f.SenderDomain != "" {
		brands[f.SenderDomain] = true
	}
	for _, d := range p.SenderDomains {
		brands[d] = true
	}

	var newDomains, young, lookalikes, freemail []string
	for _, d := range f.Candidates() {
		_, known := p.KnownDomains[d]
		if !cold && !known {
			newDomains = append(newDomains, d)
		}
		if reg, ok := cfg.Content.DomainAges[d]; ok {
			if age := ev.OccurredAt.Sub(reg); age < time.Duration(cfg.Content.YoungDays)*24*time.Hour {
				young = append(young, fmt.Sprintf("%s registered %s (%d days)",
					d, reg.Format("2006-01-02"), max(0, int(age.Hours()/24))))
			}
		}
		// Domains the account already uses (its own other domains, e.g. acmecdn.com) are never lookalikes.
		if !known && !brands[d] {
			for b := range brands {
				if Lookalike(d, b, cfg.Content.LookalikeMaxDistance, cfg.Content.LookalikeMinLen) {
					lookalikes = append(lookalikes, fmt.Sprintf("%s looks like %s", d, b))
					break
				}
			}
		}
	}
	if !cold && !p.UsedFreemailReplyTo {
		for _, d := range f.ReplyToDomains {
			if cfg.Content.Freemail[d] {
				freemail = append(freemail, d)
			}
		}
	}

	var hits []Hit
	if len(newDomains) > 0 {
		hits = append(hits, hit(in, "new_domain", CatContent,
			"never used by this account: "+strings.Join(newDomains, ", "))...)
	}
	if len(young) > 0 {
		hits = append(hits, hit(in, "young_domain", CatContent, strings.Join(young, "; "))...)
	}
	if len(lookalikes) > 0 {
		hits = append(hits, hit(in, "lookalike_domain", CatContent, strings.Join(lookalikes, "; "))...)
	}
	if len(freemail) > 0 {
		hits = append(hits, hit(in, "freemail_reply_to", CatContent,
			"first free-mail Reply-To: "+strings.Join(freemail, ", "))...)
	}
	return hits
}

// Lookalike reports whether candidate imitates brand: a typo (edit distance), the same name
// on another suffix, or a name containing the brand (acme-secure.com).
func Lookalike(candidate, brand string, maxDist, minLen int) bool {
	if candidate == brand {
		return false
	}
	c, cs := splitDomain(candidate)
	b, bs := splitDomain(brand)
	if len(b) < minLen || len(c) < minLen {
		return false
	}
	if c == b {
		return cs != bs
	}
	return strings.Contains(c, b) || levenshtein(c, b) <= maxDist
}

// splitDomain splits a registrable domain into its label and public suffix: acme.co.uk -> acme, co.uk.
func splitDomain(d string) (label, suffix string) {
	suffix, _ = publicsuffix.PublicSuffix(d)
	return strings.TrimSuffix(d, "."+suffix), suffix
}

func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}
