package engine

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/profile"
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
	ActUnblockKey        = "unblock_key"
)

// Who is the person taking an action and why. Both go to the audit log.
type Who struct {
	Actor  string
	Reason string
}

// Refusals when risky signals need the account ID typed to go ahead; %s lists the signals.
const (
	confirmLegitimate = "the evidence shows %s: type the account ID to confirm this is legitimate"
	confirmRestore    = "restoring lets this key send again, and the emails it was stopped for show %s: type the account ID to confirm"
)

// ApplyAction applies an analyst action and logs who did it and why. Marking a
// decision with risky signals (store.Warnings) legitimate also needs confirm to
// equal its account ID, as in ResolveAccount.
func (s *Service) ApplyAction(ctx context.Context, decisionID, action, confirm string, by Who) (*store.Decision, error) {
	switch action {
	case ActConfirmTakeover, ActMarkLegitimate, ActReleaseHold:
	default:
		return nil, invalid("action must be confirm_takeover, mark_legitimate or release_hold")
	}
	return s.apply(ctx, decisionID, action, confirm, by, false)
}

// OwnerRespond records the account owner's answer to a hold: "this_was_me" or "not_me".
func (s *Service) OwnerRespond(ctx context.Context, decisionID, response string) (*store.Decision, error) {
	action := map[string]string{"this_was_me": ActMarkLegitimate, "not_me": ActConfirmTakeover}[response]
	if action == "" {
		return nil, invalid("response must be this_was_me or not_me")
	}
	return s.apply(ctx, decisionID, action, "", Who{Actor: "owner", Reason: "owner response: " + response}, true)
}

func (s *Service) apply(ctx context.Context, decisionID, action, confirm string, by Who, byOwner bool) (*store.Decision, error) {
	suspendedBy := "" // who suspended the decision's key, if this action did
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
			keyReason := store.SuspendedByAnalyst
			if byOwner {
				keyReason, logged = store.SuspendedByOwner, "owner_not_me"
			}
			var hold *string
			if d.APIKeyID != nil {
				if err := store.SuspendKey(ctx, tx, *d.APIKeyID, d.AccountID, keyReason, d.DecisionID); err != nil {
					return err
				}
				suspendedBy = keyReason
				if _, err := store.DropPendingHolds(ctx, tx, *d.APIKeyID); err != nil {
					return err
				}
			} else if pending {
				// A dashboard send has no key to suspend; dropping its own hold is all there is.
				hold = ptr("dropped")
			}
			if err := store.ResolveDecision(ctx, tx, d.DecisionID, hold, ptr("takeover")); err != nil {
				return err
			}

		case ActMarkLegitimate:
			if d.Label != nil {
				return conflict("decision already labeled %s", *d.Label)
			}
			// The owner answering their own hold is the strongest evidence there is;
			// an analyst overriding attacker-looking evidence types the account ID.
			if !byOwner && confirm != d.AccountID {
				if err := requireConfirm(store.Warnings([]*store.Decision{d}), confirmLegitimate); err != nil {
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
				if err := s.learnStoredEvent(ctx, tx, d.AccountID, d.EventID); err != nil {
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
		return store.InsertAnalystAction(ctx, tx, &d.DecisionID, d.APIKeyID, logged, by.Actor, by.Reason)
	})
	if err != nil {
		return nil, err
	}
	if suspendedBy != "" {
		s.Metrics.KeysSuspended(suspendedBy, 1)
	}
	return store.DecisionByID(ctx, s.Store.Pool, decisionID, false)
}

// requireConfirm refuses an action over risky signals that wasn't confirmed by
// typing the account ID. refusal is a format with %s for the signal names.
func requireConfirm(warnings []store.Warning, refusal string) error {
	if len(warnings) == 0 {
		return nil
	}
	names := make([]string, len(warnings))
	for i, w := range warnings {
		names[i] = w.Signal
	}
	return conflict(refusal, strings.Join(names, ", "))
}

// learnStoredEvent teaches the baseline an event an analyst or owner confirmed as
// legitimate, so the new network or domain stops scoring.
func (s *Service) learnStoredEvent(ctx context.Context, tx pgx.Tx, accountID, eventID string) error {
	ev, f, p, err := lockStoredEvent(ctx, tx, accountID, eventID)
	if err != nil {
		return err
	}
	p.Learn(ev, f, s.Config)
	return store.SaveProfile(ctx, tx, p)
}

// unlearnStoredEvent takes back what learnStoredEvent taught, for an event later
// found to be an attacker's.
func unlearnStoredEvent(ctx context.Context, tx pgx.Tx, accountID, eventID string) error {
	ev, f, p, err := lockStoredEvent(ctx, tx, accountID, eventID)
	if err != nil {
		return err
	}
	p.Unlearn(ev, f)
	return store.SaveProfile(ctx, tx, p)
}

// lockStoredEvent rebuilds a stored event and its features (the body was never
// stored, only what the profile needs) and locks the account's profile.
func lockStoredEvent(ctx context.Context, tx pgx.Tx, accountID, eventID string) (*event.Event, event.Features, *profile.Profile, error) {
	row, err := store.EventRow(ctx, tx, eventID)
	if err != nil {
		return nil, event.Features{}, nil, err
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
	return ev, f, p, err
}

func ptr[T any](v T) *T { return &v }
