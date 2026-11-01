// Command seed posts a deterministic demo to a running server and checks every decision (SPEC §11.1):
// 60 days of normal sending for acc_acme, a campaign spike, a clean-history lookalike on acc_beta,
// then a takeover on acc_acme: hold 75 -> block 90 -> key_suspended.
//
// Event ids are fixed, so re-running returns the stored decisions. Run `make db-reset` for a fresh demo.
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
	"strings"
	"time"

	"github.com/poojadesai14/resend-ato/internal/event"
)

type hit struct {
	Name string `json:"name"`
}

type response struct {
	Action    string `json:"action"`
	Score     int    `json:"score"`
	Reason    string `json:"reason"`
	Unscored  bool   `json:"unscored"`
	LatencyUS int    `json:"latency_us"`
	Hits      []hit  `json:"hits"`
}

func (r response) String() string {
	names := make([]string, len(r.Hits))
	for i, h := range r.Hits {
		names[i] = h.Name
	}
	s := fmt.Sprintf("%-5s %3d  %s", r.Action, r.Score, strings.Join(names, ", "))
	if r.Reason != "" {
		s += "  (" + r.Reason + ")"
	}
	return s
}

type client struct {
	url, token string
	http       *http.Client
	serverUS   []int           // scoring latency reported by the server
	roundTrip  []time.Duration // full HTTP round trip seen by the client
}

func (c *client) post(ev *event.Event) response {
	body, _ := json.Marshal(ev)
	req, _ := http.NewRequest("POST", c.url+"/v1/events", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+c.token)
	start := time.Now()
	res, err := c.http.Do(req)
	if err != nil {
		fail("post %s: %v", ev.EventID, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		var e map[string]string
		json.NewDecoder(res.Body).Decode(&e)
		fail("post %s: HTTP %d %s", ev.EventID, res.StatusCode, e["error"])
	}
	var r response
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		fail("decode %s: %v", ev.EventID, err)
	}
	if r.Unscored {
		fail("%s was not scored (server failed open) - check the server log", ev.EventID)
	}
	c.roundTrip = append(c.roundTrip, time.Since(start))
	c.serverUS = append(c.serverUS, r.LatencyUS)
	return r
}

var (
	aws = event.Network{IP: "52.94.236.248", ASN: 16509, ASNOrg: "AMAZON-02"}
	do  = event.Network{IP: "167.99.10.20", ASN: 14061, ASNOrg: "DIGITALOCEAN-ASN"}
)

func send(id, account, key string, at time.Time, net event.Network, from string, recipients int, links ...string) *event.Event {
	to := make(event.StringList, recipients)
	for i := range to {
		to[i] = fmt.Sprintf("customer%d@example.org", i)
	}
	var html strings.Builder
	html.WriteString("<p>Your monthly update.</p>")
	for _, l := range links {
		fmt.Fprintf(&html, `<a href="https://%s/x">link</a>`, l)
	}
	return &event.Event{
		EventID: id, Type: event.TypeEmailSend, OccurredAt: at, AccountID: account, APIKeyID: key,
		Source: "api", Network: net, Client: event.Client{UserAgent: "resend-node:4.0.0"},
		Email: &event.Email{From: from, To: to, HTML: html.String()},
	}
}

func main() {
	url := flag.String("url", envOr("SEED_URL", "http://localhost:8080"), "server base URL")
	flag.Parse()
	token := os.Getenv("INGEST_TOKEN")
	if token == "" {
		fail("INGEST_TOKEN is not set")
	}
	c := &client{url: strings.TrimRight(*url, "/"), token: token, http: &http.Client{Timeout: 10 * time.Second}}
	rng := rand.New(rand.NewPCG(1, 2))

	// The takeover happens yesterday at 02:00 UTC, a quiet hour, so only the attacker's sends are in the window.
	// Yesterday, not today, so no event is dated in the future whenever the seed runs.
	today := time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, -1)
	takeover := today.Add(2 * time.Hour)

	// 1. 60 days of normal sending: one send per business hour, 20-60 recipients, from AWS.
	fmt.Println("1. acc_acme: 60 days of normal sending")
	counts := map[string]int{}
	campaignSpikes := 0
	for day := 60; day >= 1; day-- {
		for hour := 9; hour <= 17; hour++ {
			at := today.AddDate(0, 0, -day).Add(time.Duration(hour)*time.Hour + time.Duration(rng.IntN(50))*time.Minute)
			links := []string{"stripe.com"}
			if rng.IntN(3) == 0 {
				links = append(links, "twitter.com")
			}
			id := fmt.Sprintf("seed_acme_%d_%d", day, hour)
			r := c.post(send(id, "acc_acme", "key_prod_1", at, aws, "Acme <billing@acme.com>", 20+rng.IntN(41), links...))
			counts[r.Action]++
			if r.Action != "allow" {
				fail("history %s: %s", id, r)
			}

			// 2. One campaign hour, 30 days ago: ten sends of 40 recipients at 14:00.
			if day == 30 && hour == 14 {
				for i := 0; i < 10; i++ {
					id := fmt.Sprintf("seed_acme_campaign_%d", i)
					r := c.post(send(id, "acc_acme", "key_prod_1", at.Add(time.Duration(i+1)*time.Minute), aws,
						"Acme <news@acme.com>", 40, "stripe.com"))
					if r.Action != "allow" {
						fail("campaign %s: %s", id, r)
					}
					if slices.ContainsFunc(r.Hits, func(h hit) bool { return h.Name == "recipient_spike" }) {
						campaignSpikes++
					}
				}
			}
		}
	}
	fmt.Printf("   %d events, all allow\n", counts["allow"])
	if campaignSpikes == 0 {
		fail("campaign hour never triggered recipient_spike")
	}
	fmt.Printf("2. campaign hour: %d sends hit recipient_spike, all still allow\n", campaignSpikes)

	// 3. Clean-history account: five normal sends, then a link to a young lookalike.
	fmt.Println("3. acc_beta (clean history): young lookalike link")
	for i := 0; i < 5; i++ {
		c.post(send(fmt.Sprintf("seed_beta_%d", i), "acc_beta", "key_beta_1", today.AddDate(0, 0, -2).Add(time.Duration(i)*time.Hour),
			aws, "hello@beta.io", 3, "stripe.com"))
	}
	r := c.post(send("seed_beta_lookalike", "acc_beta", "key_beta_1", today.AddDate(0, 0, -1), aws, "hello@beta.io", 3, "betta.io"))
	fmt.Println("   ", r)
	expect(r, "flag", 50, "")

	// 4. Takeover on acc_acme from DigitalOcean with a young link domain.
	fmt.Println("4. acc_acme takeover from AS14061 with invoice-portal.net")
	r = c.post(send("seed_takeover_0", "acc_acme", "key_prod_1", takeover, do, "Acme Billing <billing@acme.com>", 1, "invoice-portal.net"))
	fmt.Println("    first send:", r)
	expect(r, "hold", 75, "")

	holds, blocked := 1, false
	for i := 1; i <= 40; i++ {
		r = c.post(send(fmt.Sprintf("seed_takeover_%d", i), "acc_acme", "key_prod_1", takeover.Add(time.Duration(i)*20*time.Second),
			do, "Acme Billing <billing@acme.com>", 5, "invoice-portal.net"))
		switch {
		case !blocked && r.Action == "hold":
			holds++
		case !blocked && r.Action == "block":
			fmt.Printf("    sends 1-%d held, send %d: %s\n", holds, i+1, r)
			expect(r, "block", 90, "")
			blocked = true
		case blocked:
			if r.Action != "block" || r.Reason != "key_suspended" {
				fail("after suspension: %s", r)
			}
		default:
			fail("takeover send %d: %s", i, r)
		}
	}
	if !blocked {
		fail("40 takeover sends never blocked")
	}
	fmt.Println("    every later send:", r)

	fmt.Printf("\nPASS: %d events\n", len(c.serverUS))
	printLatency(c)
}

func expect(r response, action string, score int, reason string) {
	if r.Action != action || r.Score != score || r.Reason != reason {
		fail("got %s, want %s %d %s", r, action, score, reason)
	}
}

func printLatency(c *client) {
	us := slices.Clone(c.serverUS)
	slices.Sort(us)
	rt := slices.Clone(c.roundTrip)
	slices.Sort(rt)
	pct := func(n int, p float64) int { return min(n-1, int(float64(n)*p)) }
	n := len(us)
	fmt.Printf("latency  scoring (server): p50 %.1fms  p95 %.1fms  max %.1fms\n",
		float64(us[pct(n, .5)])/1000, float64(us[pct(n, .95)])/1000, float64(us[n-1])/1000)
	fmt.Printf("         HTTP round trip:  p50 %.1fms  p95 %.1fms  max %.1fms\n",
		ms(rt[pct(n, .5)]), ms(rt[pct(n, .95)]), ms(rt[n-1]))
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

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
