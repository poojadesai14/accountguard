package engine

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/store"
)

// Analyst actions on a decision (SPEC §6.2). Owners use the same two outcomes via OwnerRespond.
const (
	ActConfirmTakeover = "confirm_takeover"
	ActMarkLegitimate  = "mark_legitimate"
	ActReleaseHold     = "release_hold"
)

var ErrNotFound = errors.New("not found")

// ConflictError means the action doesn't apply to the current state (e.g. hold already released).
type ConflictError struct{ Msg string }

func (e *ConflictError) Error() string { return e.Msg }

func conflict(format string, a ...any) error { return &ConflictError{fmt.Sprintf(format, a...)} }

// ApplyAction applies an analyst action and logs who did it and why.
func (s *Service) ApplyAction(ctx context.Context, decisionID, action, actor, reason string) (*store.Decision, error) {
	return s.apply(ctx, decisionID, action, actor, reason, false)
}

// OwnerRespond records the account owner's answer to a hold: "this_was_me" or "not_me".
func (s *Service) OwnerRespond(ctx context.Context, decisionID, response string) (*store.Decision, error) {
	action := map[string]string{"this_was_me": ActMarkLegitimate, "not_me": ActConfirmTakeover}[response]
	if action == "" {
		return nil, fmt.Errorf("response must be this_was_me or not_me")
	}
	return s.apply(ctx, decisionID, action, "owner", "owner response: "+response, true)
}

func (s *Service) apply(ctx context.Context, decisionID, action, actor, reason string, byOwner bool) (*store.Decision, error) {
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
			if byOwner {
				logged = "owner_this_was_me"
			}
			var hold *string
			if pending {
				hold = ptr("released")
			}
			if err := s.learnFromStoredEvent(ctx, tx, d.AccountID, d.EventID); err != nil {
				return err
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
	p.Learn(ev, f, s.Config)
	return store.SaveProfile(ctx, tx, p)
}

// UnblockKey reverses a suspension.
func (s *Service) UnblockKey(ctx context.Context, apiKeyID, actor, reason string) error {
	return pgx.BeginFunc(ctx, s.Store.Pool, func(tx pgx.Tx) error {
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
