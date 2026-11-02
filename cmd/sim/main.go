// Command sim measures detection quality (SPEC §11.2-11.3). It generates labeled accounts, posts their
// events to a running server in time order, and reports precision, recall, false positives per 1,000
// legitimate accounts, and emails delivered before a takeover was stopped.
//
// Two kinds of account:
//   - historical: 30-45 days of normal sending, so history-based signals are active
//   - clean:      a few days of sending, still in cold start; only history-free signals work
//
// Each account gets one scenario on "day 0" (today): normal, a legitimate change, or a takeover.
// Events from the attacker are labeled malicious; everything the owner sends is benign.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/event"
)

var (
	clouds = []event.Network{
		{IP: "52.94.236.248", ASN: 16509, ASNOrg: "AMAZON-02"},
		{IP: "34.120.10.10", ASN: 15169, ASNOrg: "GOOGLE"},
		{IP: "20.42.0.10", ASN: 8075, ASNOrg: "MICROSOFT"},
		{IP: "167.99.10.20", ASN: 14061, ASNOrg: "DIGITALOCEAN-ASN"},
		{IP: "95.216.1.1", ASN: 24940, ASNOrg: "HETZNER"},
		{IP: "51.38.1.1", ASN: 16276, ASNOrg: "OVH"},
	}
	// Residential proxies and VPS providers no simulated customer uses.
	attackerNets = []event.Network{
		{IP: "73.12.1.1", ASN: 7922, ASNOrg: "COMCAST"},
		{IP: "89.187.1.1", ASN: 60068, ASNOrg: "CDN77"},
		{IP: "45.137.1.1", ASN: 49453, ASNOrg: "GLOBAL-LAYER"},
	}
	commonLinks = []string{"stripe.com", "twitter.com", "linkedin.com", "youtube.com", "intercom.io",
		"calendly.com", "notion.so", "github.com"}
	// Phishing domains that are NOT young: aged or compromised sites.
	agedPhishing = []string{"cloud-docs-viewer.com", "secure-file-transfer.net", "wp-blog-archive.org"}
	brandWords   = []string{"northwind", "bluepeak", "copperleaf", "brightpath", "quillstack", "lumenly",
		"harborview", "pinecrest", "tidewater", "ironbark", "silverline", "maplewood"}
)

type planned struct {
	ev        *event.Event
	malicious bool
}

type account struct {
	id, kind  string // kind: historical | clean
	sc        scenario
	brand     string
	key       string
	nets      []event.Network // nets[0] is the primary network
	bizHours  bool
	base      int // typical recipients per send
	links     []string
	rng       *rand.Rand
	youngPool []string
	events    []planned
}

func (a *account) add(ev *event.Event, malicious bool) {
	ev.EventID = fmt.Sprintf("%s_%d", a.id, len(a.events))
	ev.AccountID = a.id
	if ev.APIKeyID == "" {
		ev.APIKeyID = a.key
	}
	ev.Source = "api"
	ev.Client = event.Client{UserAgent: "resend-go/2.10.0"}
	a.events = append(a.events, planned{ev, malicious})
}

func (a *account) send(at time.Time, net event.Network, recipients int, links []string, replyTo string, malicious bool) {
	to := make(event.StringList, max(1, recipients))
	for i := range to {
		to[i] = fmt.Sprintf("r%d@example.org", i)
	}
	var html strings.Builder
	html.WriteString("<p>Hello</p>")
	for _, l := range links {
		fmt.Fprintf(&html, `<a href="https://%s/p">link</a>`, l)
	}
	e := &event.Email{From: "team@" + a.brand, To: to, HTML: html.String()}
	if replyTo != "" {
		e.ReplyTo = event.StringList{replyTo}
	}
	a.add(&event.Event{Type: event.TypeEmailSend, OccurredAt: at, Network: net, Email: e}, malicious)
}

// change records an account change; target is what it changed, such as the new key.
func (a *account) change(at time.Time, net event.Network, kind, target string, malicious bool) {
	a.add(&event.Event{Type: event.TypeAccountChange, OccurredAt: at, Network: net,
		Change: &event.Change{Kind: kind, TargetID: target}}, malicious)
}

func (a *account) normalSend(at time.Time) {
	net := a.nets[0]
	if len(a.nets) > 1 && a.rng.IntN(5) == 0 {
		net = a.nets[1]
	}
	n := int(float64(a.base) * (0.5 + a.rng.Float64()))
	a.send(at, net, n, []string{a.links[a.rng.IntN(len(a.links))]}, "", false)
}

func (a *account) normalDay(day time.Time) {
	if a.kind == "clean" {
		for range 2 + a.rng.IntN(3) {
			a.normalSend(day.Add(time.Duration(8+a.rng.IntN(10))*time.Hour + time.Duration(a.rng.IntN(60))*time.Minute))
		}
		return
	}
	for h := 0; h < 24; h++ {
		if (a.bizHours && (h < 9 || h > 17)) || (!a.bizHours && h%2 == 1) {
			continue
		}
		a.normalSend(day.Add(time.Duration(h)*time.Hour + time.Duration(a.rng.IntN(50))*time.Minute))
	}
}

func (a *account) attackerNet() event.Network { return attackerNets[a.rng.IntN(len(attackerNets))] }
func (a *account) young() string              { return a.youngPool[a.rng.IntN(len(a.youngPool))] }
func (a *account) otherCloud() event.Network {
	for {
		c := clouds[a.rng.IntN(len(clouds))]
		if !slices.ContainsFunc(a.nets, func(n event.Network) bool { return n.ASN == c.ASN }) {
			return c
		}
	}
}

// repeat calls fn n times, gap apart, starting at t0.
func repeat(n int, t0 time.Time, gap time.Duration, fn func(at time.Time)) {
	for i := range n {
		fn(t0.Add(time.Duration(i) * gap))
	}
}

type scenario struct {
	name     string
	takeover bool
	clean    bool // also runs on clean-history accounts
	run      func(a *account, t0 time.Time)
}

var scenarios = []scenario{
	// Legitimate changes.
	{"normal", false, true, func(a *account, t0 time.Time) {}},
	{"campaign", false, true, func(a *account, t0 time.Time) {
		repeat(8, t0, 5*time.Minute, func(at time.Time) { a.send(at, a.nets[0], a.base*2, a.links[:1], "", false) })
	}},
	{"cloud_migration", false, false, func(a *account, t0 time.Time) {
		to := a.otherCloud()
		repeat(6, t0, time.Hour, func(at time.Time) { a.send(at, to, a.base, a.links[:1], "", false) })
	}},
	{"new_helpdesk_reply_to", false, false, func(a *account, t0 time.Time) {
		repeat(4, t0, time.Hour, func(at time.Time) {
			a.send(at, a.nets[0], a.base, a.links[:1], "support@"+strings.TrimSuffix(a.brand, ".com")+".zendesk.com", false)
		})
	}},
	{"new_partner_link", false, true, func(a *account, t0 time.Time) {
		repeat(4, t0, time.Hour, func(at time.Time) { a.send(at, a.nets[0], a.base, []string{"typeform.com"}, "", false) })
	}},
	{"new_api_key", false, false, func(a *account, t0 time.Time) {
		a.change(t0, a.nets[0], "api_key.created", a.key+"_new", false)
		repeat(4, t0.Add(10*time.Minute), time.Hour, func(at time.Time) {
			a.send(at, a.nets[0], a.base, a.links[:1], "", false)
			a.events[len(a.events)-1].ev.APIKeyID = a.key + "_new"
		})
	}},
	{"new_member_then_campaign", false, false, func(a *account, t0 time.Time) {
		a.change(t0, a.nets[0], "team_member.added", "member_"+a.id, false)
		repeat(8, t0.Add(30*time.Minute), 5*time.Minute, func(at time.Time) { a.send(at, a.nets[0], a.base*2, a.links[:1], "", false) })
	}},
	{"owner_uses_gmail_reply_to", false, false, func(a *account, t0 time.Time) {
		repeat(4, t0, time.Hour, func(at time.Time) { a.send(at, a.nets[0], a.base, a.links[:1], "founder.team@gmail.com", false) })
	}},

	// Takeovers.
	{"takeover_fast", true, true, func(a *account, t0 time.Time) {
		net, d := a.attackerNet(), a.young()
		repeat(25, t0, time.Minute, func(at time.Time) { a.send(at, net, 20, []string{d}, "", true) })
	}},
	{"takeover_slow", true, true, func(a *account, t0 time.Time) {
		net, d := a.attackerNet(), a.young()
		repeat(8, t0, 45*time.Minute, func(at time.Time) { a.send(at, net, 3, []string{d}, "", true) })
	}},
	{"takeover_same_cloud", true, false, func(a *account, t0 time.Time) {
		d := a.young()
		repeat(8, t0, 30*time.Minute, func(at time.Time) { a.send(at, a.nets[0], 5, []string{d}, "", true) })
	}},
	{"takeover_compromised_server", true, false, func(a *account, t0 time.Time) {
		d := agedPhishing[a.rng.IntN(len(agedPhishing))]
		repeat(8, t0, 30*time.Minute, func(at time.Time) { a.send(at, a.nets[0], 5, []string{d}, "", true) })
	}},
	{"takeover_bec_gmail_reply_to", true, true, func(a *account, t0 time.Time) {
		net := a.attackerNet()
		repeat(8, t0, 30*time.Minute, func(at time.Time) { a.send(at, net, 2, nil, "ceo.office.urgent@gmail.com", true) })
	}},
	{"takeover_bec_same_cloud", true, false, func(a *account, t0 time.Time) {
		repeat(8, t0, 30*time.Minute, func(at time.Time) { a.send(at, a.nets[0], 2, nil, "ceo.office.urgent@gmail.com", true) })
	}},
	{"takeover_recon_then_send", true, false, func(a *account, t0 time.Time) {
		net, d := a.attackerNet(), a.young()
		a.add(&event.Event{Type: event.TypeAPIRead, OccurredAt: t0, Network: net,
			Read: &event.Read{Resource: "contacts", Status: 200}}, true)
		// Persistence: a backup key the attacker never sends with.
		a.change(t0.Add(2*time.Minute), net, "api_key.created", a.key+"_backup", true)
		repeat(10, t0.Add(10*time.Minute), 3*time.Minute, func(at time.Time) { a.send(at, net, 10, []string{d}, "", true) })
	}},
	{"takeover_brand_lookalike", true, true, func(a *account, t0 time.Time) {
		net, d := a.attackerNet(), strings.TrimSuffix(a.brand, ".com")+"-secure.com"
		repeat(8, t0, 20*time.Minute, func(at time.Time) { a.send(at, net, 5, []string{d}, "", true) })
	}},
	{"takeover_known_domain_abuse", true, false, func(a *account, t0 time.Time) {
		// Link via a file-sharing domain the account already uses, from the owner's own cloud: expected miss.
		repeat(8, t0, 30*time.Minute, func(at time.Time) { a.send(at, a.nets[0], 5, []string{"google.com"}, "", true) })
	}},
}

func newAccount(i int, run string, cleanShare, takeoverShare float64, youngPool []string, today time.Time) *account {
	rng := rand.New(rand.NewPCG(42, uint64(i)))
	a := &account{
		id:        fmt.Sprintf("sim_%s_%03d", run, i),
		kind:      "historical",
		brand:     fmt.Sprintf("%s%d.com", brandWords[i%len(brandWords)], i),
		bizHours:  rng.IntN(10) < 7,
		base:      5 + rng.IntN(145),
		rng:       rng,
		youngPool: youngPool,
	}
	a.key = a.id + "_key"
	if rng.Float64() < cleanShare {
		a.kind = "clean"
	}
	a.nets = []event.Network{clouds[rng.IntN(len(clouds))]}
	if rng.IntN(10) < 3 {
		a.nets = append(a.nets, a.otherCloud())
	}
	perm := rng.Perm(len(commonLinks))
	for _, j := range perm[:2+rng.IntN(3)] {
		a.links = append(a.links, commonLinks[j])
	}

	takeover := rng.Float64() < takeoverShare
	var eligible []scenario
	for _, s := range scenarios {
		if s.takeover == takeover && (a.kind == "historical" || s.clean) {
			eligible = append(eligible, s)
		}
	}
	a.sc = eligible[rng.IntN(len(eligible))]
	if a.sc.name == "takeover_known_domain_abuse" {
		a.links = append(a.links, "google.com")
	}

	days := 30 + rng.IntN(16)
	if a.kind == "clean" {
		days = 2 + rng.IntN(3)
	}
	for d := days; d >= 1; d-- {
		a.normalDay(today.AddDate(0, 0, -d))
	}
	a.normalDay(today)
	hour := 10 + rng.IntN(6)
	if takeover {
		hour = 1 + rng.IntN(20)
	}
	a.sc.run(a, today.Add(time.Duration(hour)*time.Hour+time.Duration(rng.IntN(60))*time.Minute))

	sort.SliceStable(a.events, func(x, y int) bool { return a.events[x].ev.OccurredAt.Before(a.events[y].ev.OccurredAt) })
	return a
}

type response struct {
	Action    string `json:"action"`
	Score     int    `json:"score"`
	Reason    string `json:"reason"`
	Unscored  bool   `json:"unscored"`
	LatencyUS int    `json:"latency_us"`
	Hits      []struct {
		Name string `json:"name"`
	} `json:"hits"`
}

type outcome struct {
	p planned
	r response
}

func main() {
	url := flag.String("url", envOr("SEED_URL", "http://localhost:8080"), "server base URL")
	n := flag.Int("accounts", 200, "number of accounts")
	cleanShare := flag.Float64("clean", 0.3, "share of clean-history (cold start) accounts")
	takeoverShare := flag.Float64("takeovers", 0.4, "share of accounts that get a takeover")
	workers := flag.Int("workers", 8, "accounts posted in parallel (each account stays in order)")
	cfgPath := flag.String("config", envOr("CONFIG_PATH", "config.yaml"), "server config, to find young domains")
	run := flag.String("run", time.Now().UTC().Format("0102_1504"), "run id, keeps event ids unique across runs")
	flag.Parse()

	token := os.Getenv("INGEST_TOKEN")
	if token == "" {
		fail("INGEST_TOKEN is not set")
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fail("%v", err)
	}
	// The simulated "today" is yesterday (UTC), so every event, including a
	// scenario placed late in the day, is in the past when it is posted. Real
	// events never arrive from the future, and the analyst UI's time ranges end
	// at now, so future-dated events would be invisible on the account page.
	today := time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, -1)
	var youngPool []string
	for d, reg := range cfg.Content.DomainAges {
		if today.Sub(reg) < time.Duration(cfg.Content.YoungDays)*24*time.Hour && !strings.Contains(d, "acrne") && !strings.Contains(d, "betta") {
			youngPool = append(youngPool, d)
		}
	}
	sort.Strings(youngPool)
	if len(youngPool) == 0 {
		fail("config has no domain_ages younger than %d days - add some for today's date", cfg.Content.YoungDays)
	}

	accounts := make([]*account, *n)
	total := 0
	for i := range accounts {
		accounts[i] = newAccount(i, *run, *cleanShare, *takeoverShare, youngPool, today)
		total += len(accounts[i].events)
		if last := accounts[i].events[len(accounts[i].events)-1].ev.OccurredAt; last.After(time.Now()) {
			fail("%s has an event at %s, in the future; scenarios must end before now", accounts[i].id, last.Format(time.RFC3339))
		}
	}
	fmt.Printf("Posting %d events for %d accounts to %s ...\n", total, *n, *url)

	httpc := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: *workers}}
	results := make([][]outcome, *n)
	var latencies []int
	var mu sync.Mutex
	jobs := make(chan int)
	var wg sync.WaitGroup
	start := time.Now()
	for range *workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				for _, p := range accounts[i].events {
					r := post(httpc, *url, token, p.ev)
					results[i] = append(results[i], outcome{p, r})
					mu.Lock()
					latencies = append(latencies, r.LatencyUS)
					mu.Unlock()
				}
			}
		}()
	}
	for i := range accounts {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(start)

	report(accounts, results)
	slices.Sort(latencies)
	fmt.Printf("\n%d events in %s (%.0f/s); server scoring latency p50 %.1fms p95 %.1fms\n",
		total, elapsed.Round(time.Second), float64(total)/elapsed.Seconds(),
		float64(latencies[len(latencies)/2])/1000, float64(latencies[len(latencies)*95/100])/1000)
	if n := unscoredRetries.Load(); n > 0 {
		fmt.Printf("%d events missed the scoring deadline and were resent (production would allow them unscored)\n", n)
	}
	if n := networkRetries.Load(); n > 0 {
		fmt.Printf("%d posts were resent after a dropped connection or a 5xx\n", n)
	}
}

// unscoredRetries counts events the server failed open on and that were resent;
// networkRetries counts resends after a dropped connection or a 5xx.
var unscoredRetries, networkRetries atomic.Int64

// post sends one event. Resending is safe: event_id makes ingestion idempotent,
// and a fail-open answer rolls the event back. A few retries absorb latency spikes
// and dropped connections on a small hosted instance without losing the event.
func post(c *http.Client, url, token string, ev *event.Event) response {
	body, _ := json.Marshal(ev)
	const attempts = 5
	for attempt := 1; ; attempt++ {
		r, err := postOnce(c, url, token, ev.EventID, body)
		switch {
		case err == nil && !r.Unscored:
			return r
		case attempt == attempts && err != nil:
			fail("post %s: %v (after %d attempts)", ev.EventID, err, attempt)
		case attempt == attempts:
			fail("%s was not scored after %d attempts (server failed open) - check the server log", ev.EventID, attempt)
		case err != nil:
			networkRetries.Add(1)
			time.Sleep(time.Duration(attempt) * time.Second)
		default:
			unscoredRetries.Add(1)
		}
	}
}

// postOnce returns an error only for failures worth retrying: a dropped or timed
// out connection, or a 5xx. A 4xx means the event itself is wrong, so it stops the run.
func postOnce(c *http.Client, url, token, eventID string, body []byte) (response, error) {
	req, _ := http.NewRequest("POST", strings.TrimRight(url, "/")+"/v1/events", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := c.Do(req)
	if err != nil {
		return response{}, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 500 {
		return response{}, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var r response
	if res.StatusCode != http.StatusOK {
		fail("post %s: HTTP %d", eventID, res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		return response{}, err
	}
	return r, nil
}

var rank = map[string]int{"allow": 0, "flag": 1, "hold": 2, "block": 3}

func stops(a string) bool { return a == "hold" || a == "block" }

// collateral: owner events blocked only because the key was already suspended.
func collateral(o outcome) bool { return !o.p.malicious && o.r.Reason == "key_suspended" }

func report(accounts []*account, results [][]outcome) {
	fmt.Println("\n## Event level: precision / recall at each action threshold")
	fmt.Println("(owner emails blocked only because the key was already suspended are counted separately below)")
	fmt.Println()
	fmt.Println("| accounts | threshold | precision | recall | malicious events | benign events |")
	fmt.Println("|---|---|---|---|---|---|")
	for _, kind := range []string{"historical", "clean", "all"} {
		for _, thr := range []string{"flag", "hold", "block"} {
			var tp, fp, fn, mal, ben int
			for i, a := range accounts {
				if kind != "all" && a.kind != kind {
					continue
				}
				for _, o := range results[i] {
					hit := rank[o.r.Action] >= rank[thr]
					switch {
					case o.p.malicious:
						mal++
						if hit {
							tp++
						} else {
							fn++
						}
					case collateral(o):
					default:
						ben++
						if hit {
							fp++
						}
					}
				}
			}
			fmt.Printf("| %s | >= %s | %s | %s | %d | %d |\n", kind, thr, pct(tp, tp+fp), pct(tp, tp+fn), mal, ben)
		}
	}

	fmt.Println("\n## Takeover scenarios (per account)")
	fmt.Println("stopped = at least one attacker email held or blocked; delivered = attacker emails that went out (allow or flag)")
	fmt.Println()
	fmt.Println("| scenario | kind | accounts | flagged | stopped | attacker emails delivered | sent | typical first action |")
	fmt.Println("|---|---|---|---|---|---|---|---|")
	for _, s := range scenarios {
		if !s.takeover {
			continue
		}
		for _, kind := range []string{"historical", "clean"} {
			var nAcc, flagged, stopped, delivered, sent int
			first := map[string]int{}
			for i, a := range accounts {
				if a.sc.name != s.name || a.kind != kind {
					continue
				}
				nAcc++
				anyFlag, anyStop, firstAction := false, false, ""
				for _, o := range results[i] {
					if !o.p.malicious {
						continue
					}
					if firstAction == "" {
						firstAction = o.r.Action
					}
					anyFlag = anyFlag || o.r.Action != "allow"
					anyStop = anyStop || stops(o.r.Action)
					if o.p.ev.Type == event.TypeEmailSend {
						sent++
						if !stops(o.r.Action) {
							delivered++
						}
					}
				}
				first[firstAction]++
				if anyFlag {
					flagged++
				}
				if anyStop {
					stopped++
				}
			}
			if nAcc == 0 {
				continue
			}
			fmt.Printf("| %s | %s | %d | %s | %s | %d | %d | %s |\n",
				s.name, kind, nAcc, pct(flagged, nAcc), pct(stopped, nAcc), delivered, sent, mostCommon(first))
		}
	}

	fmt.Println("\n## Legitimate accounts: share with any owner event flagged / held / blocked")
	fmt.Println()
	fmt.Println("| scenario | kind | accounts | flag+ | hold+ | block |")
	fmt.Println("|---|---|---|---|---|---|")
	var legit, lFlag, lHold, lBlock int
	for _, s := range scenarios {
		if s.takeover {
			continue
		}
		for _, kind := range []string{"historical", "clean"} {
			var nAcc, f, h, b int
			for i, a := range accounts {
				if a.sc.name != s.name || a.kind != kind {
					continue
				}
				nAcc++
				worst := 0
				for _, o := range results[i] {
					worst = max(worst, rank[o.r.Action])
				}
				if worst >= 1 {
					f++
				}
				if worst >= 2 {
					h++
				}
				if worst >= 3 {
					b++
				}
			}
			if nAcc == 0 {
				continue
			}
			legit, lFlag, lHold, lBlock = legit+nAcc, lFlag+f, lHold+h, lBlock+b
			fmt.Printf("| %s | %s | %d | %s | %s | %s |\n", s.name, kind, nAcc, pct(f, nAcc), pct(h, nAcc), pct(b, nAcc))
		}
	}
	if legit > 0 {
		fmt.Printf("\nFalse positives per 1,000 legitimate accounts: flag %.0f, hold %.0f, block %.0f\n",
			1000*float64(lFlag)/float64(legit), 1000*float64(lHold)/float64(legit), 1000*float64(lBlock)/float64(legit))
	}

	fmt.Println("\n## Signals: how often each fired on attacker vs owner events")
	fmt.Println()
	fmt.Println("| signal | attacker events | owner events | precision |")
	fmt.Println("|---|---|---|---|")
	type counts struct{ mal, ben int }
	bySignal := map[string]*counts{}
	collat, collatAccounts := 0, 0
	for i := range accounts {
		hadCollat := false
		for _, o := range results[i] {
			if collateral(o) {
				collat++
				hadCollat = true
				continue
			}
			for _, h := range o.r.Hits {
				c := bySignal[h.Name]
				if c == nil {
					c = &counts{}
					bySignal[h.Name] = c
				}
				if o.p.malicious {
					c.mal++
				} else {
					c.ben++
				}
			}
		}
		if hadCollat {
			collatAccounts++
		}
	}
	names := make([]string, 0, len(bySignal))
	for name := range bySignal {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		c := bySignal[name]
		fmt.Printf("| %s | %d | %d | %s |\n", name, c.mal, c.ben, pct(c.mal, c.mal+c.ben))
	}
	fmt.Printf("\nCost of suspending keys: %d owner emails on %d accounts were blocked because their key was suspended.\n",
		collat, collatAccounts)
}

func pct(a, b int) string {
	if b == 0 {
		return "-"
	}
	return fmt.Sprintf("%.0f%%", 100*float64(a)/float64(b))
}

func mostCommon(m map[string]int) string {
	best, n := "", -1
	for k, v := range m {
		if v > n || (v == n && k < best) {
			best, n = k, v
		}
	}
	return best
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "FAIL: "+format+"\n", a...)
	os.Exit(1)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
