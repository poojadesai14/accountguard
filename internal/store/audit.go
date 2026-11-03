package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// AnalystAction is one audit log entry: who did what, to which decision or key, and why.
type AnalystAction struct {
	ID         int64     `json:"id" db:"id"`
	DecisionID *string   `json:"decision_id" db:"decision_id"`
	APIKeyID   *string   `json:"api_key_id" db:"api_key_id"`
	Action     string    `json:"action" db:"action"`
	Actor      string    `json:"actor" db:"actor"`
	Reason     string    `json:"reason" db:"reason"`
	CreatedAt  time.Time `json:"created_at" db:"created_at"`
}

// ActionsForDecision lists the audit entries for a decision, oldest first.
func ActionsForDecision(ctx context.Context, db DBTX, decisionID string) ([]AnalystAction, error) {
	rows, err := db.Query(ctx, `
		select id, decision_id::text as decision_id, api_key_id, action, actor, reason, created_at
		from analyst_actions where decision_id = $1::uuid order by created_at`, decisionID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[AnalystAction])
}

// InsertAnalystAction writes an audit entry. decisionID is nil for an action on a
// key alone, apiKeyID for a decision with no key.
func InsertAnalystAction(ctx context.Context, db DBTX, decisionID, apiKeyID *string, action, actor, reason string) error {
	_, err := db.Exec(ctx, `
		insert into analyst_actions (decision_id, api_key_id, action, actor, reason)
		values ($1::uuid, $2, $3, $4, $5)`, decisionID, apiKeyID, action, actor, reason)
	return err
}

// GlobalAnalystAction is an audit entry with the account it concerns.
type GlobalAnalystAction struct {
	AnalystAction
	AccountID *string `json:"account_id"`
}

// AnalystActionPage is one page of the audit log, newest first. NextBeforeID is
// the before_id of the next page, nil on the last.
type AnalystActionPage struct {
	Items        []GlobalAnalystAction `json:"items"`
	NextBeforeID *int64                `json:"next_before_id"`
}

// ListAnalystActions pages the audit log by descending id: entries in r with an
// id below beforeID (0 for the first page).
func ListAnalystActions(ctx context.Context, db DBTX, r Range, beforeID int64, limit int) (*AnalystActionPage, error) {
	rows, err := db.Query(ctx, `select a.id, a.decision_id::text, a.api_key_id, a.action, a.actor, a.reason, a.created_at,
 coalesce(d.account_id,k.account_id) as account_id
 from analyst_actions a left join decisions d on d.decision_id = a.decision_id
 left join key_status k on k.api_key_id = a.api_key_id
 where`+fmt.Sprintf(rangeSQL, "a.created_at", 1, 2)+`and ($3::bigint = 0 or a.id < $3)
 order by a.id desc limit $4`, r.From, r.To, beforeID, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := &AnalystActionPage{Items: []GlobalAnalystAction{}}
	for rows.Next() {
		var item GlobalAnalystAction
		if err := rows.Scan(&item.ID, &item.DecisionID, &item.APIKeyID, &item.Action, &item.Actor, &item.Reason, &item.CreatedAt, &item.AccountID); err != nil {
			return nil, err
		}
		result.Items = append(result.Items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		id := result.Items[limit-1].ID
		result.NextBeforeID = &id
	}
	return result, nil
}
