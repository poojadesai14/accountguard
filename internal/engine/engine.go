// Package engine runs the signals, sums points and picks the action (SPEC §4).
// engine.go is pure; service.go wraps it in the database transaction.
package engine

import (
	"slices"

	"github.com/poojadesai14/resend-ato/internal/action"
	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/signal"
)

// Action is defined in package action, which the store can import to rank actions in SQL.
type Action = action.Action

const (
	Allow = action.Allow
	Flag  = action.Flag
	Hold  = action.Hold
	Block = action.Block
)

// ReasonKeySuspended is the decision reason for an event sent with a suspended key.
const ReasonKeySuspended = "key_suspended"

// Result is what Evaluate decided and why.
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
	for _, eval := range signal.All {
		hits = append(hits, eval(in)...)
	}
	score, action, reason := Decide(hits, keySuspended, in.Event.APIKeyID != "", in.Config)
	return Result{Hits: hits, Score: score, Action: action, Reason: reason}
}

// Decide: one category alone can at most flag (content excepted, which can hold);
// block needs a high score AND agreement between categories.
func Decide(hits []signal.Hit, keySuspended, hasKey bool, cfg *config.Config) (score int, act Action, reason string) {
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
		act = Block
	case score >= t.Hold:
		act = Hold
	case score >= t.Flag:
		act = Flag
	}

	if len(cats) == 1 && !slices.Contains(t.SingleCategoryExempt, cats[0]) {
		capAt, _ := action.Parse(t.SingleCategoryCap)
		act = min(act, capAt)
	}
	// Without a key there is nothing to suspend.
	if !hasKey {
		act = min(act, Hold)
	}
	return score, act, ""
}
