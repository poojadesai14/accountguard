package main

import (
	"fmt"
	"sort"

	"github.com/poojadesai14/accountguard/internal/action"
	"github.com/poojadesai14/accountguard/internal/event"
)

// severity ranks an action name from the server; an unknown one ranks as allow.
func severity(name string) action.Action {
	a, _ := action.Parse(name)
	return a
}

func stops(a string) bool { return severity(a) >= action.Hold }

// collateral: owner events blocked only because the key was already suspended.
func collateral(o outcome) bool { return !o.p.malicious && o.r.Reason == "key_suspended" }

// report prints the detection-quality tables as Markdown.
func report(accounts []*account, results [][]outcome) {
	reportThresholds(accounts, results)
	reportTakeovers(accounts, results)
	reportLegitimate(accounts, results)
	reportSignals(accounts, results)
}

// reportThresholds: event-level precision and recall at each action threshold.
func reportThresholds(accounts []*account, results [][]outcome) {
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
					hit := severity(o.r.Action) >= severity(thr)
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
}

// reportTakeovers: per takeover scenario, how many accounts were flagged or
// stopped and how many attacker emails went out first.
func reportTakeovers(accounts []*account, results [][]outcome) {
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
}

// reportLegitimate: false positives, as the share of legitimate accounts with any
// owner event flagged, held or blocked.
func reportLegitimate(accounts []*account, results [][]outcome) {
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
				worst := action.Allow
				for _, o := range results[i] {
					worst = max(worst, severity(o.r.Action))
				}
				if worst >= action.Flag {
					f++
				}
				if worst >= action.Hold {
					h++
				}
				if worst >= action.Block {
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
}

// reportSignals: how often each signal fired on attacker and owner events, and
// what suspending keys cost owners.
func reportSignals(accounts []*account, results [][]outcome) {
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
