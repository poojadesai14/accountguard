package engine

import (
	"context"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/resend-ato/internal/store"
)

// SuspendKey suspends a key on an analyst's authority, whatever its decisions say,
// and drops its pending holds: the way back from a wrong legitimate call.
func (s *Service) SuspendKey(ctx context.Context, apiKeyID string, by Who) (holdsDropped int, err error) {
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
		if err := store.SuspendKey(ctx, tx, apiKeyID, accountID, store.SuspendedByAnalyst, ""); err != nil {
			return err
		}
		dropped, err := store.DropPendingHolds(ctx, tx, apiKeyID)
		if err != nil {
			return err
		}
		holdsDropped = int(dropped)
		return store.InsertAnalystAction(ctx, tx, nil, &apiKeyID, ActSuspendKey, by.Actor, by.Reason)
	})
	if err == nil {
		s.Metrics.KeysSuspended(store.SuspendedByAnalyst, 1)
	}
	return holdsDropped, err
}

// UnblockKey reverses a suspension. On an account with a confirmed takeover it
// also needs confirm to equal the account ID: restoring there is recovery, after
// the owner has secured the account and rotated credentials, not cleanup. So does
// a key stopped for risky signals (store.KeyWarnings), even if those emails were
// marked legitimate: the analyst sees the evidence and types the ID to proceed.
func (s *Service) UnblockKey(ctx context.Context, apiKeyID, confirm string, by Who) error {
	return pgx.BeginFunc(ctx, s.Store.Pool, func(tx pgx.Tx) error {
		accountID, takeover, found, err := store.KeyTakeover(ctx, tx, apiKeyID)
		if err != nil {
			return err
		}
		if found && confirm != accountID {
			if takeover {
				return conflict("this key was locked for a confirmed takeover: type the account ID to confirm the owner has secured the account and rotated credentials")
			}
			warnings, err := store.KeyWarnings(ctx, tx, apiKeyID)
			if err != nil {
				return err
			}
			if err := requireConfirm(warnings, confirmRestore); err != nil {
				return err
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
		return store.InsertAnalystAction(ctx, tx, nil, &apiKeyID, ActUnblockKey, by.Actor, by.Reason)
	})
}

// suspendForTakeover suspends each key on the analyst's authority, tied to its first
// takeover decision, drops its pending holds (adding them to holdsDropped) and
// returns the keys in order.
func suspendForTakeover(ctx context.Context, tx pgx.Tx, accountID string, keyDecision map[string]string, holdsDropped *int) ([]string, error) {
	keys := []string{}
	for key, decisionID := range keyDecision {
		if err := store.SuspendKey(ctx, tx, key, accountID, store.SuspendedByAnalyst, decisionID); err != nil {
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
