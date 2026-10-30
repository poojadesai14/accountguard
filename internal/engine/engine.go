// Package engine runs the signals, sums points and picks the action (SPEC §4).
// engine.go is pure; service.go wraps it in the database transaction.
package engine

import (
	"slices"

	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/signal"
)

type Action int

const (
	Allow Action = iota
	Flag
	Hold
	Block
)

var actionNames = []string{"allow", "flag", "hold", "block"}

func (a Action) String() string { return actionNames[a] }

func ParseAction(s string) (Action, bool) {
	i := slices.Index(actionNames, s)
	return Action(max(i, 0)), i >= 0
}

const ReasonKeySuspended = "key_suspended"

type Result struct {
	Hits   []signal.Hit
	Score  int
	Action Action
	Reason string
}

// Evaluate runs every signal in order and decides. Signals are microsecond in-memory checks,
// so they run sequentially; concurrency is across requests.
func Evaluate(in *signal.Input, keySuspended bool) Result {
	hits := []signal.Hit{}
	for _, s := range signal.All {
		hits = append(hits, s.Eval(in)...)
	}
	score, action, reason := Decide(hits, keySuspended, in.Event.APIKeyID != "", in.Config)
	return Result{Hits: hits, Score: score, Action: action, Reason: reason}
}

// Decide: one category alone can at most flag (content excepted, which can hold);
// block needs a high score AND agreement between categories.
func Decide(hits []signal.Hit, keySuspended, hasKey bool, cfg *config.Config) (score int, action Action, reason string) {
	var cats []string
	for _, h := range hits {
		score += h.Points
		if !slices.Contains(cats, h.Category) {
			cats = append(cats, h.Category)
		}
	}
	score = min(score, cfg.Scoring.MaxScore)

	if keySuspended {
		return score, Block, ReasonKeySuspended
	}

	t := cfg.Thresholds
	switch {
	case score >= t.Block && len(cats) >= t.BlockMinCategories:
		action = Block
	case score >= t.Hold:
		action = Hold
	case score >= t.Flag:
		action = Flag
	}

	if len(cats) == 1 && !slices.Contains(t.SingleCategoryExempt, cats[0]) {
		capAt, _ := ParseAction(t.SingleCategoryCap)
		action = min(action, capAt)
	}
	// Without a key there is nothing to suspend.
	if !hasKey {
		action = min(action, Hold)
	}
	return score, action, ""
}
