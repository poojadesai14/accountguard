package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Who suspended a key: the values of key_status.reason while it is suspended.
const (
	SuspendedByEngine  = "auto"
	SuspendedByAnalyst = "analyst"
	SuspendedByOwner   = "owner"
)

// KeySuspended reports whether a key is suspended now. A key with no status row is active.
func KeySuspended(ctx context.Context, db DBTX, apiKeyID string) (bool, error) {
	var status string
	err := db.QueryRow(ctx, `select status from key_status where api_key_id = $1`, apiKeyID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return status == "suspended", err
}

// SuspendKey suspends one API key; decisionID may be empty for a suspension no
// decision caused (an analyst acting on the key directly). The account and its other keys keep working.
func SuspendKey(ctx context.Context, db DBTX, apiKeyID, accountID, reason, decisionID string) error {
	_, err := db.Exec(ctx, `
		insert into key_status (api_key_id, account_id, status, reason, decision_id)
		values ($1, $2, 'suspended', $3, nullif($4, '')::uuid)
		on conflict (api_key_id) do update
		set status = 'suspended', reason = excluded.reason, decision_id = excluded.decision_id, updated_at = now()`,
		apiKeyID, accountID, reason, decisionID)
	return err
}

// ActivateKey un-suspends a key. found is false if the key has no status row.
func ActivateKey(ctx context.Context, db DBTX, apiKeyID string) (wasSuspended, found bool, err error) {
	var status string
	err = db.QueryRow(ctx, `select status from key_status where api_key_id = $1 for update`, apiKeyID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, true, err
	}
	_, err = db.Exec(ctx, `
		update key_status set status = 'active', reason = 'analyst', updated_at = now()
		where api_key_id = $1`, apiKeyID)
	return status == "suspended", true, err
}

// autoSuspendedKey matches a key_status row k that the engine suspended, on an
// account with no confirmed takeover anywhere (on any key, or none). Restoring one
// is safe once the decision that suspended it is judged legitimate. A key an
// analyst or the owner suspended, or any key on an account with a confirmed
// takeover, stays as it is: those are restored one at a time, on purpose.
const autoSuspendedKey = `k.status = 'suspended' and k.reason = 'auto'
	and not exists (select 1 from decisions t where t.account_id = k.account_id and t.label = 'takeover')`

// suspendedForLegitimate adds: the decision that suspended k is labelled legitimate.
const suspendedForLegitimate = autoSuspendedKey + `
	and exists (select 1 from decisions kd where kd.decision_id = k.decision_id and kd.label = 'legitimate')`

// RestorableKeys locks the account's keys that resolving these decisions as
// legitimate may restore: auto-suspended (autoSuspendedKey) by one of them, or by
// a decision already marked legitimate.
func RestorableKeys(ctx context.Context, db DBTX, accountID string, decisionIDs []string) ([]string, error) {
	rows, err := db.Query(ctx, `select k.api_key_id from key_status k
		where k.account_id = $1 and `+autoSuspendedKey+`
		and (k.decision_id = any($2::uuid[])
			or exists (select 1 from decisions kd where kd.decision_id = k.decision_id and kd.label = 'legitimate'))
		order by k.api_key_id for update of k`, accountID, decisionIDs)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// KeyAccount finds the account a key belongs to and whether it is suspended, from
// its status row or, for a key never suspended, its latest event.
func KeyAccount(ctx context.Context, db DBTX, apiKeyID string) (accountID string, suspended, found bool, err error) {
	var status *string
	err = db.QueryRow(ctx, `select account_id, status from (
		select account_id, status, 0 as source, null::timestamptz as at from key_status where api_key_id = $1
		union all
		(select account_id, null, 1, occurred_at from events where api_key_id = $1 order by occurred_at desc limit 1)
		union all
		-- A key that was created but never used: an attacker's backup can be suspended
		-- before it sends.
		(select account_id, null, 2, occurred_at from events
		  where type = 'account.change' and change_kind = 'api_key.created' and change_target_id = $1
		  order by occurred_at desc limit 1)
		) k order by source limit 1`, apiKeyID).Scan(&accountID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, false, nil
	}
	return accountID, status != nil && *status == "suspended", err == nil, err
}

// KeyStatus is a key's suspension state and what restoring it would need.
type KeyStatus struct {
	APIKeyID   string    `json:"api_key_id" db:"api_key_id"`
	AccountID  string    `json:"account_id" db:"account_id"`
	Status     string    `json:"status" db:"status"`
	Reason     string    `json:"reason" db:"reason"`
	DecisionID *string   `json:"decision_id" db:"decision_id"`
	UpdatedAt  time.Time `json:"updated_at" db:"updated_at"`
	// The account has a confirmed takeover: restoring needs the account ID typed.
	Takeover bool `json:"takeover" db:"takeover"`
	// Risky signals on the emails a suspended key was stopped for (KeyWarnings):
	// restoring it also needs the account ID typed, with this evidence shown.
	Warnings []Warning `json:"warnings" db:"-"`
}

// takeoverOnAccount: any decision on the key_status row's account is labelled takeover.
const takeoverOnAccount = `exists (select 1 from decisions t where t.account_id = key_status.account_id and t.label = 'takeover')`

// KeyTakeover finds a key's account and whether that account has a confirmed takeover.
func KeyTakeover(ctx context.Context, db DBTX, apiKeyID string) (accountID string, takeover, found bool, err error) {
	err = db.QueryRow(ctx, `select account_id, `+takeoverOnAccount+` from key_status where api_key_id = $1`, apiKeyID).
		Scan(&accountID, &takeover)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, false, nil
	}
	return accountID, takeover, err == nil, err
}

const keyStatusSelect = `
	select api_key_id, account_id, status, reason, decision_id::text as decision_id, updated_at,
		` + takeoverOnAccount + ` as takeover
	from key_status`

// KeyStatuses lists an account's keys that have a status row, most recently changed first.
func KeyStatuses(ctx context.Context, db DBTX, accountID string) ([]KeyStatus, error) {
	rows, err := db.Query(ctx, keyStatusSelect+` where account_id = $1 order by updated_at desc`, accountID)
	if err != nil {
		return nil, err
	}
	return collectKeyStatuses(ctx, db, rows)
}

// KeyStatusOf returns one of the account's keys, or nil if it has no status row.
func KeyStatusOf(ctx context.Context, db DBTX, accountID, apiKeyID string) (*KeyStatus, error) {
	rows, err := db.Query(ctx, keyStatusSelect+` where account_id = $1 and api_key_id = $2`, accountID, apiKeyID)
	if err != nil {
		return nil, err
	}
	keys, err := collectKeyStatuses(ctx, db, rows)
	if err != nil || len(keys) == 0 {
		return nil, err
	}
	return &keys[0], nil
}

// collectKeyStatuses scans rows selected with keyStatusSelect and adds each
// suspended key's warnings.
func collectKeyStatuses(ctx context.Context, db DBTX, rows pgx.Rows) ([]KeyStatus, error) {
	keys, err := pgx.CollectRows(rows, pgx.RowToStructByName[KeyStatus])
	if err != nil {
		return nil, err
	}
	for i := range keys {
		keys[i].Warnings = []Warning{}
		if keys[i].Status == "suspended" {
			if keys[i].Warnings, err = KeyWarnings(ctx, db, keys[i].APIKeyID); err != nil {
				return nil, err
			}
		}
	}
	return keys, nil
}

// KeyWarnings lists the risky signals (RiskySignals) on the holds and blocks a key
// was stopped for: scored stops on the key from 24 hours before the decision that
// suspended it, whatever they were labelled. A takeover label is handled by the
// account-level lock instead. Restoring such a key lets that sender send again.
func KeyWarnings(ctx context.Context, db DBTX, apiKeyID string) ([]Warning, error) {
	rows, err := db.Query(ctx, `select `+decisionCols+` from decisions d
		where d.api_key_id = $1 and d.action in ('hold','block') and d.reason is null
		and d.occurred_at >= coalesce((select s.occurred_at from key_status k join decisions s on s.decision_id = k.decision_id
			where k.api_key_id = $1), now()) - interval '24 hours'
		order by d.occurred_at`, apiKeyID)
	if err != nil {
		return nil, err
	}
	stops, err := collectDecisions(rows)
	if err != nil {
		return nil, err
	}
	return Warnings(stops), nil
}

// CreatedKey is a key an account.change event says was created, still not deleted.
// A key the attacker creates for persistence may never send before it's found, so
// the analyst sees it here rather than only once it sends.
type CreatedKey struct {
	APIKeyID  string    `json:"api_key_id"`
	CreatedAt time.Time `json:"created_at"`
}

// CreatedKeys lists the account's 50 most recently created keys that were not deleted since.
func CreatedKeys(ctx context.Context, db DBTX, accountID string) ([]CreatedKey, error) {
	rows, err := db.Query(ctx, `select change_target_id, max(occurred_at) from events e
		where account_id = $1 and type = 'account.change' and change_kind = 'api_key.created'
		  and change_target_id is not null
		  and not exists (select 1 from events d where d.account_id = $1 and d.type = 'account.change'
		    and d.change_kind = 'api_key.deleted' and d.change_target_id = e.change_target_id
		    and d.occurred_at >= e.occurred_at)
		group by change_target_id order by 2 desc, 1 limit 50`, accountID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[CreatedKey])
}
