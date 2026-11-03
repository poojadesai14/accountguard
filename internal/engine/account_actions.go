package engine

import (
	"context"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/resend-ato/internal/store"
)

// Correction reports what CorrectToTakeover changed.
type Correction struct {
	Corrected     int      `json:"corrected"`
	HoldsDropped  int      `json:"holds_dropped"`
	KeysSuspended []string `json:"keys_suspended"`
}

// CorrectToTakeover relabels decisions an analyst or owner wrongly marked legitimate
// as takeover, in one transaction: the baseline unlearns each event, the keys they
// were sent with are suspended on the analyst's authority and lose their pending
// holds. Emails already released stay sent; the audit log says so. Every decision
// must belong to the account and be labelled legitimate, or nothing changes.
func (s *Service) CorrectToTakeover(ctx context.Context, accountID string, decisionIDs []string, by Who) (*Correction, error) {
	ids := slices.Compact(slices.Sorted(slices.Values(decisionIDs)))
	if len(ids) == 0 {
		return nil, invalid("choose at least one decision to correct")
	}
	audit := "correction: " + by.Reason
	res := &Correction{KeysSuspended: []string{}}
	err := pgx.BeginFunc(ctx, s.Store.Pool, func(tx pgx.Tx) error {
		decisions, err := store.DecisionsByIDs(ctx, tx, accountID, ids)
		if err != nil {
			return err
		}
		if len(decisions) != len(ids) {
			return conflict("some decisions are not on this account; reload and try again")
		}
		keyDecision := map[string]string{} // the first corrected decision sent with each key
		for _, d := range decisions {
			if d.Label == nil || *d.Label != "legitimate" {
				return conflict("decision %s is not marked legitimate; reload and try again", d.DecisionID)
			}
			if err := unlearnStoredEvent(ctx, tx, d.AccountID, d.EventID); err != nil {
				return err
			}
			var hold *string
			if d.HoldStatus != nil && *d.HoldStatus == "pending" {
				hold, res.HoldsDropped = ptr("dropped"), res.HoldsDropped+1
			}
			if err := store.ResolveDecision(ctx, tx, d.DecisionID, hold, ptr("takeover")); err != nil {
				return err
			}
			if err := store.InsertAnalystAction(ctx, tx, &d.DecisionID, d.APIKeyID, ActCorrectToTakeover, by.Actor, audit); err != nil {
				return err
			}
			if d.APIKeyID != nil {
				if _, ok := keyDecision[*d.APIKeyID]; !ok {
					keyDecision[*d.APIKeyID] = d.DecisionID
				}
			}
			res.Corrected++
		}
		res.KeysSuspended, err = suspendForTakeover(ctx, tx, accountID, keyDecision, &res.HoldsDropped)
		return err
	})
	if err != nil {
		return nil, err
	}
	s.Metrics.KeysSuspended(store.SuspendedByAnalyst, len(res.KeysSuspended))
	return res, nil
}

// Outcomes of an account-level resolution.
const (
	ResolveLegitimate = "legitimate"
	ResolveTakeover   = "takeover"
)

// ResolveRequest is an analyst's resolution of every open review on an account.
type ResolveRequest struct {
	// Seen are the open reviews the analyst looked at.
	Seen    []string
	Outcome string // ResolveLegitimate or ResolveTakeover
	// RestoreKeys also restores the keys a legitimate outcome makes safe to restore.
	RestoreKeys bool
	// Confirm is the account ID, typed when the reviews show risky signals.
	Confirm string
	Who
}

func (r ResolveRequest) validate() error {
	switch {
	case r.Outcome != ResolveLegitimate && r.Outcome != ResolveTakeover:
		return invalid("outcome must be legitimate or takeover")
	case len(r.Seen) == 0:
		return invalid("decision_ids must list the open reviews being resolved")
	case r.Outcome == ResolveTakeover && r.RestoreKeys:
		return invalid("keys can only be restored when resolving as legitimate")
	}
	return nil
}

// AccountResolution reports what ResolveAccount changed.
type AccountResolution struct {
	Outcome       string   `json:"outcome"`
	Resolved      int      `json:"resolved"`
	HoldsReleased int      `json:"holds_released"`
	HoldsDropped  int      `json:"holds_dropped"`
	KeysRestored  []string `json:"keys_restored"`
	KeysSuspended []string `json:"keys_suspended"`
}

// ResolveAccount closes every open review on an account with one outcome, the way
// an analyst reasons about an incident, in one transaction. Each change is audited
// as its own action.
//
// If the account's open reviews differ from req.Seen when the transaction locks
// them, nothing changes: the analyst must look again rather than label an
// attacker's newer send unseen.
//
// Legitimate labels the open decisions legitimate (teaching the baseline from each
// stopped event) and releases their pending holds. Keys are restored only when
// req.RestoreKeys is set, and only those the engine suspended because of one of
// these decisions or by one already marked legitimate (store.RestorableKeys): a
// wrong call there lets an attacker send again.
// Takeover labels them takeover, drops their pending holds and suspends the keys
// they were sent with.
//
// A legitimate outcome over reviews with risky signals (store.Warnings) also needs
// req.Confirm to equal the account ID: those releases and restores are hard to take back.
func (s *Service) ResolveAccount(ctx context.Context, accountID string, req ResolveRequest) (*AccountResolution, error) {
	if err := req.validate(); err != nil {
		return nil, err
	}
	audit := "account resolution: " + req.Reason
	res := &AccountResolution{Outcome: req.Outcome, KeysRestored: []string{}, KeysSuspended: []string{}}
	err := pgx.BeginFunc(ctx, s.Store.Pool, func(tx pgx.Tx) error {
		open, err := store.OpenDecisions(ctx, tx, accountID)
		if err != nil {
			return err
		}
		if len(open) == 0 {
			return conflict("nothing to resolve on this account")
		}
		ids := make([]string, len(open))
		for i, d := range open {
			ids[i] = d.DecisionID
		}
		if !slices.Equal(slices.Sorted(slices.Values(ids)), slices.Sorted(slices.Values(req.Seen))) {
			return conflict("this account's open reviews changed since you loaded it; reload and review again")
		}
		if req.Outcome == ResolveLegitimate && req.Confirm != accountID {
			if err := requireConfirm(store.Warnings(open), confirmLegitimate); err != nil {
				return err
			}
		}
		// Locked before any label changes, so a takeover label written below can't hide a key.
		var restorable []string
		if req.RestoreKeys {
			if restorable, err = store.RestorableKeys(ctx, tx, accountID, ids); err != nil {
				return err
			}
		}
		keyDecision := map[string]string{} // takeover: the first open decision sent with each key
		for _, d := range open {
			pending := d.HoldStatus != nil && *d.HoldStatus == "pending"
			var hold *string
			logged := ActMarkLegitimate
			if req.Outcome == ResolveLegitimate {
				if pending {
					hold, res.HoldsReleased = ptr("released"), res.HoldsReleased+1
				}
				if d.Action != Allow.String() {
					if err := s.learnStoredEvent(ctx, tx, d.AccountID, d.EventID); err != nil {
						return err
					}
				}
			} else {
				logged = ActConfirmTakeover
				if pending {
					hold, res.HoldsDropped = ptr("dropped"), res.HoldsDropped+1
				}
				if d.APIKeyID != nil {
					if _, ok := keyDecision[*d.APIKeyID]; !ok {
						keyDecision[*d.APIKeyID] = d.DecisionID
					}
				}
			}
			if err := store.ResolveDecision(ctx, tx, d.DecisionID, hold, ptr(req.Outcome)); err != nil {
				return err
			}
			if err := store.InsertAnalystAction(ctx, tx, &d.DecisionID, d.APIKeyID, logged, req.Actor, audit); err != nil {
				return err
			}
			res.Resolved++
		}
		if req.Outcome == ResolveTakeover {
			if res.KeysSuspended, err = suspendForTakeover(ctx, tx, accountID, keyDecision, &res.HoldsDropped); err != nil {
				return err
			}
		}
		for _, key := range restorable {
			was, _, err := store.ActivateKey(ctx, tx, key)
			if err != nil {
				return err
			}
			if !was {
				continue
			}
			if err := store.InsertAnalystAction(ctx, tx, nil, &key, ActUnblockKey, req.Actor, audit); err != nil {
				return err
			}
			res.KeysRestored = append(res.KeysRestored, key)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.Metrics.KeysSuspended(store.SuspendedByAnalyst, len(res.KeysSuspended))
	return res, nil
}
