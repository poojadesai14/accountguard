package event

import (
	"net"
	"net/mail"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/publicsuffix"
)

// Features is everything we keep from an email. Bodies, subjects and addresses are dropped.
type Features struct {
	SenderDomain     string
	RecipientCount   int
	LinkDomains      []string
	ReplyToDomains   []string
	BodyEmailDomains []string
}

// Candidates is every domain the content signal checks: links, Reply-To and addresses in the body.
func (f Features) Candidates() []string {
	s := newSet()
	for _, list := range [][]string{f.LinkDomains, f.ReplyToDomains, f.BodyEmailDomains} {
		for _, d := range list {
			s.add(d)
		}
	}
	return s.sorted()
}

var (
	urlRe   = regexp.MustCompile(`(?i)\b(?:https?://|www\.)[^\s<>"']+`)
	emailRe = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})`)
)

// Extract pulls features out of an email.send event. Other event types return zero Features.
func Extract(ev *Event) Features {
	var f Features
	e := ev.Email
	if ev.Type != TypeEmailSend || e == nil {
		return f
	}

	f.SenderDomain = addrDomain(e.From)

	f.RecipientCount = len(e.To) + len(e.CC) + len(e.BCC)

	links, bodyEmails := newSet(), newSet()
	if e.HTML != "" {
		scanHTML(e.HTML, links, bodyEmails)
	}
	if e.Text != "" {
		scanText(e.Text, links, bodyEmails)
	}

	replyTo := newSet()
	addList := func(v string) {
		addrs, err := mail.ParseAddressList(v)
		if err != nil {
			replyTo.add(addrDomain(v))
			return
		}
		for _, a := range addrs {
			replyTo.add(addrDomain(a.Address))
		}
	}
	for _, r := range e.ReplyTo {
		addList(r)
	}
	for k, v := range e.Headers {
		if strings.EqualFold(k, "Reply-To") {
			addList(v)
		}
	}

	// The sender's own domain is never suspicious content.
	for _, s := range []set{links, replyTo, bodyEmails} {
		delete(s, f.SenderDomain)
	}

	f.LinkDomains = links.sorted()
	f.ReplyToDomains = replyTo.sorted()
	f.BodyEmailDomains = bodyEmails.sorted()
	return f
}

// scanHTML collects link domains from href/src/action attributes (mailto: counts as a body address)
// and runs scanText over visible text.
func scanHTML(doc string, links, emails set) {
	z := html.NewTokenizer(strings.NewReader(doc))
	for {
		switch z.Next() {
		case html.ErrorToken:
			return
		case html.TextToken:
			scanText(string(z.Text()), links, emails)
		case html.StartTagToken, html.SelfClosingTagToken:
			for {
				key, val, more := z.TagAttr()
				switch string(key) {
				case "href", "src", "action":
					v := strings.TrimSpace(string(val))
					if addr, ok := strings.CutPrefix(strings.ToLower(v), "mailto:"); ok {
						addr, _, _ = strings.Cut(addr, "?")
						emails.add(addrDomain(addr))
					} else {
						links.add(urlDomain(v))
					}
				}
				if !more {
					break
				}
			}
		}
	}
}

func scanText(text string, links, emails set) {
	for _, u := range urlRe.FindAllString(text, -1) {
		links.add(urlDomain(u))
	}
	for _, m := range emailRe.FindAllStringSubmatch(text, -1) {
		emails.add(Registrable(m[1]))
	}
}

// urlDomain returns the registrable domain of an http(s), scheme-relative or www. URL, or "".
func urlDomain(raw string) string {
	raw = strings.TrimRight(raw, ".,;:!?)]}")
	lower := strings.ToLower(raw)
	switch {
	case strings.HasPrefix(lower, "http://"), strings.HasPrefix(lower, "https://"):
	case strings.HasPrefix(lower, "//"):
		raw = "https:" + raw
	case strings.HasPrefix(lower, "www."):
		raw = "https://" + raw
	default:
		return "" // relative links, javascript:, data:, cid: ...
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return Registrable(u.Hostname())
}

func addrDomain(s string) string {
	if a, err := mail.ParseAddress(s); err == nil {
		s = a.Address
	}
	i := strings.LastIndex(s, "@")
	if i < 0 {
		return ""
	}
	return Registrable(strings.Trim(s[i+1:], " >"))
}

// Registrable reduces a host to its registrable domain (eTLD+1): app.acme.com -> acme.com.
// Returns "" for IPs and hosts without one.
func Registrable(host string) string {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "" || net.ParseIP(host) != nil || !strings.Contains(host, ".") {
		return ""
	}
	d, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		return ""
	}
	return d
}

type set map[string]struct{}

func newSet() set { return set{} }

func (s set) add(v string) {
	if v != "" {
		s[v] = struct{}{}
	}
}

func (s set) sorted() []string {
	out := make([]string, 0, len(s))
	for v := range s {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}
