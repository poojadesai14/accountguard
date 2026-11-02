package engine

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/store"
)

// Analyst actions on a decision (SPEC §6.2). Owners use the same two outcomes via OwnerRespond.
const (
	ActConfirmTakeover = "confirm_takeover"
	ActMarkLegitimate  = "mark_legitimate"
	ActReleaseHold     = "release_hold"
	// Not decision outcomes: an analyst acting on a key, or correcting a wrong label.
	ActSuspendKey        = "suspend_key"
	ActCorrectToTakeover = "correct_to_takeover"
)

var ErrNotFound = errors.New("not found")

// ConflictError means the action doesn't apply to the current state (e.g. hold already released).
type ConflictError struct{ Msg string }

func (e *ConflictError) Error() string { return e.Msg }

func conflict(format string, a ...any) error { return &ConflictError{fmt.Sprintf(format, a...)} }

// ApplyAction applies an analyst action and logs who did it and why. Marking a
// decision with risky signals (store.Warnings) legitimate also needs confirm to
// equal its account ID, as in ResolveAccount.
func (s *Service) ApplyAction(ctx context.Context, decisionID, action, confirm, actor, reason string) (*store.Decision, error) {
	return s.apply(ctx, decisionID, action, confirm, actor, reason, false)
}

// OwnerRespond records the account owner's answer to a hold: "this_was_me" or "not_me".
func (s *Service) OwnerRespond(ctx context.Context, decisionID, response string) (*store.Decision, error) {
	action := map[string]string{"this_was_me": ActMarkLegitimate, "not_me": ActConfirmTakeover}[response]
	if action == "" {
		return nil, fmt.Errorf("response must be this_was_me or not_me")
	}
	return s.apply(ctx, decisionID, action, "", "owner", "owner response: "+response, true)
}

func (s *Service) apply(ctx context.Context, decisionID, action, confirm, actor, reason string, byOwner bool) (*store.Decision, error) {
	err := pgx.BeginFunc(ctx, s.Store.Pool, func(tx pgx.Tx) error {
		d, err := store.DecisionByID(ctx, tx, decisionID, true)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		pending := d.HoldStatus != nil && *d.HoldStatus == "pending"
		if byOwner && !pending {
			return conflict("there is no pending hold to respond to")
		}

		logged := action
		switch action {
		case ActConfirmTakeover:
			if d.Label != nil {
				return conflict("decision already labeled %s", *d.Label)
			}
			if d.APIKeyID == nil {
				return conflict("event has no API key to suspend")
			}
			keyReason := "analyst"
			if byOwner {
				keyReason, logged = "owner", "owner_not_me"
			}
			if err := store.SuspendKey(ctx, tx, *d.APIKeyID, d.AccountID, keyReason, d.DecisionID); err != nil {
				return err
			}
			if _, err := store.DropPendingHolds(ctx, tx, *d.APIKeyID); err != nil {
				return err
			}
			if err := store.ResolveDecision(ctx, tx, d.DecisionID, nil, ptr("takeover")); err != nil {
				return err
			}

		case ActMarkLegitimate:
			if d.Label != nil {
				return conflict("decision already labeled %s", *d.Label)
			}
			// The owner answering their own hold is the strongest evidence there is;
			// an analyst overriding attacker-looking evidence types the account ID.
			if !byOwner && confirm != d.AccountID {
				if err := requireConfirm(store.Warnings([]*store.Decision{d})); err != nil {
					return err
				}
			}
			if byOwner {
				logged = "owner_this_was_me"
			}
			var hold *string
			if pending {
				hold = ptr("released")
			}
			// Allowed events already taught the baseline during ingestion.
			if d.Action != Allow.String() {
				if err := s.learnFromStoredEvent(ctx, tx, d.AccountID, d.EventID); err != nil {
					return err
				}
			}
			if err := store.ResolveDecision(ctx, tx, d.DecisionID, hold, ptr("legitimate")); err != nil {
				return err
			}

		case ActReleaseHold:
			if !pending {
				return conflict("hold is not pending")
			}
			if err := store.ResolveDecision(ctx, tx, d.DecisionID, ptr("released"), nil); err != nil {
				return err
			}

		default:
			return fmt.Errorf("unknown action %q", action)
		}
		return store.InsertAnalystAction(ctx, tx, &d.DecisionID, d.APIKeyID, logged, actor, reason)
	})
	if err != nil {
		return nil, err
	}
	return store.DecisionByID(ctx, s.Store.Pool, decisionID, false)
}

// learnFromStoredEvent teaches the baseline an event an analyst or owner confirmed as legitimate,
// so the new network or domain stops scoring.
func (s *Service) learnFromStoredEvent(ctx context.Context, tx pgx.Tx, accountID, eventID string) error {
	return s.foldStoredEvent(ctx, tx, accountID, eventID, true)
}

// unlearnFromStoredEvent takes back what learnFromStoredEvent taught, for an event
// later found to be an attacker's.
func (s *Service) unlearnFromStoredEvent(ctx context.Context, tx pgx.Tx, accountID, eventID string) error {
	return s.foldStoredEvent(ctx, tx, accountID, eventID, false)
}

func (s *Service) foldStoredEvent(ctx context.Context, tx pgx.Tx, accountID, eventID string, learn bool) error {
	row, err := store.EventRow(ctx, tx, eventID)
	if err != nil {
		return err
	}
	ev := &event.Event{Type: row.Type, OccurredAt: row.OccurredAt, AccountID: accountID}
	if row.APIKeyID != nil {
		ev.APIKeyID = *row.APIKeyID
	}
	if row.ASN != nil {
		ev.Network.ASN = *row.ASN
	}
	f := event.Features{
		RecipientCount:   row.RecipientCount,
		LinkDomains:      row.LinkDomains,
		ReplyToDomains:   row.ReplyToDomains,
		BodyEmailDomains: row.BodyEmailDomains,
	}
	if row.SenderDomain != nil {
		f.SenderDomain = *row.SenderDomain
	}

	p, err := store.LockProfile(ctx, tx, accountID, row.OccurredAt)
	if err != nil {
		return err
	}
	if learn {
		p.Learn(ev, f, s.Config)
	} else {
		p.Unlearn(ev, f)
	}
	return store.SaveProfile(ctx, tx, p)
}

// SuspendKey suspends a key on an analyst's authority, whatever its decisions say,
// and drops its pending holds: the way back from a wrong legitimate call.
func (s *Service) SuspendKey(ctx context.Context, apiKeyID, actor, reason string) (holdsDropped int, err error) {
	err = pgx.BeginFunc(ctx, s.Store.Pool, func(tx pgx.Tx) error {
		accountID, suspended, found, err := store.KeyAccount(ctx, tx, apiKeyID)
		switch {
		case err != nil:
			return err
		case !found:
			return ErrNotFound
		case suspended:
			return conflict("key is already suspended")
		}
		if err := store.SuspendKey(ctx, tx, apiKeyID, accountID, "analyst", ""); err != nil {
			return err
		}
		dropped, err := store.DropPendingHolds(ctx, tx, apiKeyID)
		if err != nil {
			return err
		}
		holdsDropped = int(dropped)
		return store.InsertAnalystAction(ctx, tx, nil, &apiKeyID, ActSuspendKey, actor, reason)
	})
	return holdsDropped, err
}

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
func (s *Service) CorrectToTakeover(ctx context.Context, accountID string, decisionIDs []string, actor, reason string) (*Correction, error) {
	ids := slices.Compact(slices.Sorted(slices.Values(decisionIDs)))
	if len(ids) == 0 {
		return nil, fmt.Errorf("choose at least one decision to correct")
	}
	audit := "correction: " + reason
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
			if err := s.unlearnFromStoredEvent(ctx, tx, d.AccountID, d.EventID); err != nil {
				return err
			}
			var hold *string
			if d.HoldStatus != nil && *d.HoldStatus == "pending" {
				hold, res.HoldsDropped = ptr("dropped"), res.HoldsDropped+1
			}
			if err := store.ResolveDecision(ctx, tx, d.DecisionID, hold, ptr("takeover")); err != nil {
				return err
			}
			if err := store.InsertAnalystAction(ctx, tx, &d.DecisionID, d.APIKeyID, ActCorrectToTakeover, actor, audit); err != nil {
				return err
			}
			if d.APIKeyID != nil {
				if _, seen := keyDecision[*d.APIKeyID]; !seen {
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
	return res, nil
}

// suspendForTakeover suspends each key on the analyst's authority, tied to its first
// takeover decision, drops its pending holds (adding them to holdsDropped) and
// returns the keys in order.
func suspendForTakeover(ctx context.Context, tx pgx.Tx, accountID string, keyDecision map[string]string, holdsDropped *int) ([]string, error) {
	keys := []string{}
	for key, decisionID := range keyDecision {
		if err := store.SuspendKey(ctx, tx, key, accountID, "analyst", decisionID); err != nil {
			return nil, err
		}
		dropped, err := store.DropPendingHolds(ctx, tx, key)
		if err != nil {
			return nil, err
		}
		*holdsDropped += int(dropped)
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys, nil
}

// UnblockKey reverses a suspension. On an account with a confirmed takeover it
// also needs confirm to equal the account ID: restoring there is recovery, after
// the owner has secured the account and rotated credentials, not cleanup. So does
// a key stopped for risky signals (store.KeyWarnings), even if those emails were
// marked legitimate: the analyst sees the evidence and types the ID to proceed.
func (s *Service) UnblockKey(ctx context.Context, apiKeyID, confirm, actor, reason string) error {
	return pgx.BeginFunc(ctx, s.Store.Pool, func(tx pgx.Tx) error {
		accountID, takeover, found, err := store.KeyTakeover(ctx, tx, apiKeyID)
		if err != nil {
			return err
		}
		if found && takeover && confirm != accountID {
			return conflict("this key was locked for a confirmed takeover: type the account ID to confirm the owner has secured the account and rotated credentials")
		}
		if found && confirm != accountID {
			warnings, err := store.KeyWarnings(ctx, tx, apiKeyID)
			if err != nil {
				return err
			}
			if len(warnings) > 0 {
				names := make([]string, len(warnings))
				for i, w := range warnings {
					names[i] = w.Signal
				}
				return conflict("restoring lets this key send again, and the emails it was stopped for show %s: type the account ID to confirm", strings.Join(names, ", "))
			}
		}
		wasSuspended, found, err := store.ActivateKey(ctx, tx, apiKeyID)
		switch {
		case err != nil:
			return err
		case !found:
			return ErrNotFound
		case !wasSuspended:
			return conflict("key is not suspended")
		}
		return store.InsertAnalystAction(ctx, tx, nil, &apiKeyID, "unblock_key", actor, reason)
	})
}

func ptr[T any](v T) *T { return &v }

// requireConfirm refuses a legitimate call over risky signals that wasn't confirmed
// by typing the account ID.
func requireConfirm(warnings []store.Warning) error {
	if len(warnings) == 0 {
		return nil
	}
	names := make([]string, len(warnings))
	for i, w := range warnings {
		names[i] = w.Signal
	}
	return conflict("the evidence shows %s: type the account ID to confirm this is legitimate", strings.Join(names, ", "))
}

// Outcomes of an account-level resolution.
const (
	ResolveLegitimate = "legitimate"
	ResolveTakeover   = "takeover"
)

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
// seen are the open reviews the analyst looked at. If the account's open reviews
// differ when the transaction locks them, nothing changes: the analyst must look
// again rather than label an attacker's newer send unseen.
//
// Legitimate labels the open decisions legitimate (teaching the baseline from each
// stopped event) and releases their pending holds. Keys are restored only when
// restoreKeys is set, and only those the engine suspended because of one of these
// decisions or by one already marked legitimate (store.RestorableKeys): a wrong
// call there lets an attacker send again.
// Takeover labels them takeover, drops their pending holds and suspends the keys
// they were sent with.
//
// A legitimate outcome over reviews with risky signals (store.Warnings) also needs
// confirm to equal the account ID: those releases and restores are hard to take back.
func (s *Service) ResolveAccount(ctx context.Context, accountID string, seen []string, outcome string, restoreKeys bool, confirm, actor, reason string) (*AccountResolution, error) {
	if outcome != ResolveLegitimate && outcome != ResolveTakeover {
		return nil, fmt.Errorf("outcome must be legitimate or takeover")
	}
	if outcome == ResolveTakeover && restoreKeys {
		return nil, fmt.Errorf("keys can only be restored when resolving as legitimate")
	}
	audit := "account resolution: " + reason
	res := &AccountResolution{Outcome: outcome, KeysRestored: []string{}, KeysSuspended: []string{}}
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
		want := slices.Clone(seen)
		slices.Sort(want)
		if got := slices.Sorted(slices.Values(ids)); !slices.Equal(got, want) {
			return conflict("this account's open reviews changed since you loaded it; reload and review again")
		}
		if outcome == ResolveLegitimate && confirm != accountID {
			if err := requireConfirm(store.Warnings(open)); err != nil {
				return err
			}
		}
		// Locked before any label changes, so a takeover label written below can't hide a key.
		var restorable []string
		if restoreKeys {
			if restorable, err = store.RestorableKeys(ctx, tx, accountID, ids); err != nil {
				return err
			}
		}
		keyDecision := map[string]string{} // takeover: the first open decision sent with each key
		for _, d := range open {
			pending := d.HoldStatus != nil && *d.HoldStatus == "pending"
			var hold *string
			logged := ActMarkLegitimate
			if outcome == ResolveLegitimate {
				if pending {
					hold, res.HoldsReleased = ptr("released"), res.HoldsReleased+1
				}
				if d.Action != Allow.String() {
					if err := s.learnFromStoredEvent(ctx, tx, d.AccountID, d.EventID); err != nil {
						return err
					}
				}
			} else {
				logged = ActConfirmTakeover
				if pending {
					hold, res.HoldsDropped = ptr("dropped"), res.HoldsDropped+1
				}
				if d.APIKeyID != nil {
					if _, seen := keyDecision[*d.APIKeyID]; !seen {
						keyDecision[*d.APIKeyID] = d.DecisionID
					}
				}
			}
			if err := store.ResolveDecision(ctx, tx, d.DecisionID, hold, ptr(outcome)); err != nil {
				return err
			}
			if err := store.InsertAnalystAction(ctx, tx, &d.DecisionID, d.APIKeyID, logged, actor, audit); err != nil {
				return err
			}
			res.Resolved++
		}
		if outcome == ResolveTakeover {
			if res.KeysSuspended, err = suspendForTakeover(ctx, tx, accountID, keyDecision, &res.HoldsDropped); err != nil {
				return err
			}
		}
		if restoreKeys {
			for _, key := range restorable {
				was, _, err := store.ActivateKey(ctx, tx, key)
				if err != nil {
					return err
				}
				if !was {
					continue
				}
				if err := store.InsertAnalystAction(ctx, tx, nil, &key, "unblock_key", actor, audit); err != nil {
					return err
				}
				res.KeysRestored = append(res.KeysRestored, key)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}
