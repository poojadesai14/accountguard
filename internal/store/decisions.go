package store

import (
	"context"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/accountguard/internal/signal"
)

// Decision is one scored event: the action, the hits behind it, and what
// reviewers did with it since.
type Decision struct {
	DecisionID    string       `json:"decision_id"`
	EventID       string       `json:"event_id"`
	AccountID     string       `json:"account_id"`
	APIKeyID      *string      `json:"api_key_id"`
	OccurredAt    time.Time    `json:"occurred_at"`
	DecidedAt     time.Time    `json:"decided_at"`
	Action        string       `json:"action"`
	Enforced      bool         `json:"enforced"`
	Score         int          `json:"score"`
	Hits          []signal.Hit `json:"hits"`
	Reason        *string      `json:"reason"`
	ConfigVersion string       `json:"config_version"`
	LatencyUS     int          `json:"latency_us"`
	HoldStatus    *string      `json:"hold_status"`
	HoldExpiresAt *time.Time   `json:"hold_expires_at"`
	ReviewStatus  string       `json:"review_status"`
	Label         *string      `json:"label"`
}

const decisionCols = `decision_id::text, event_id, account_id, api_key_id, occurred_at, decided_at,
	action, enforced, score, hits, reason, config_version, coalesce(latency_us, 0),
	hold_status, hold_expires_at, review_status, label`

func scanDecision(row pgx.Row) (*Decision, error) {
	var d Decision
	err := row.Scan(&d.DecisionID, &d.EventID, &d.AccountID, &d.APIKeyID, &d.OccurredAt, &d.DecidedAt,
		&d.Action, &d.Enforced, &d.Score, &d.Hits, &d.Reason, &d.ConfigVersion, &d.LatencyUS,
		&d.HoldStatus, &d.HoldExpiresAt, &d.ReviewStatus, &d.Label)
	if d.Hits == nil {
		d.Hits = []signal.Hit{}
	}
	return &d, err
}

// collectDecisions scans rows selected with decisionCols and closes them.
func collectDecisions(rows pgx.Rows) ([]*Decision, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (*Decision, error) { return scanDecision(row) })
}

// DecisionByID loads a decision; forUpdate locks it for the rest of the transaction.
func DecisionByID(ctx context.Context, db DBTX, decisionID string, forUpdate bool) (*Decision, error) {
	q := `select ` + decisionCols + ` from decisions where decision_id = $1::uuid`
	if forUpdate {
		q += ` for update`
	}
	return scanDecision(db.QueryRow(ctx, q, decisionID))
}

// DecisionByEvent loads the decision made for an event.
func DecisionByEvent(ctx context.Context, db DBTX, eventID string) (*Decision, error) {
	return scanDecision(db.QueryRow(ctx, `select `+decisionCols+` from decisions where event_id = $1`, eventID))
}

// InsertDecision fills in DecisionID and DecidedAt.
func InsertDecision(ctx context.Context, db DBTX, d *Decision) error {
	return db.QueryRow(ctx, `
		insert into decisions (
			event_id, account_id, api_key_id, occurred_at, action, enforced, score, hits, reason,
			config_version, latency_us, hold_status, hold_expires_at, review_status)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		returning decision_id::text, decided_at`,
		d.EventID, d.AccountID, d.APIKeyID, d.OccurredAt, d.Action, d.Enforced, d.Score, d.Hits, d.Reason,
		d.ConfigVersion, d.LatencyUS, d.HoldStatus, d.HoldExpiresAt, d.ReviewStatus,
	).Scan(&d.DecisionID, &d.DecidedAt)
}

// ResolveDecision marks a decision reviewed, optionally changing its hold status and label.
func ResolveDecision(ctx context.Context, db DBTX, decisionID string, holdStatus, label *string) error {
	_, err := db.Exec(ctx, `
		update decisions
		set hold_status = coalesce($2, hold_status), label = coalesce($3, label), review_status = 'resolved'
		where decision_id = $1::uuid`, decisionID, holdStatus, label)
	return err
}

// DropPendingHolds drops every pending hold for a key (confirmed takeover).
func DropPendingHolds(ctx context.Context, db DBTX, apiKeyID string) (int64, error) {
	tag, err := db.Exec(ctx, `
		update decisions set hold_status = 'dropped'
		where api_key_id = $1 and hold_status = 'pending'`, apiKeyID)
	return tag.RowsAffected(), err
}

// ExpireHolds marks pending holds past their expiry as expired. They stay open for review.
func ExpireHolds(ctx context.Context, db DBTX) (int64, error) {
	tag, err := db.Exec(ctx, `
		update decisions set hold_status = 'expired'
		where hold_status = 'pending' and hold_expires_at < now()`)
	return tag.RowsAffected(), err
}

// PendingHolds counts holds waiting for an owner or analyst.
func PendingHolds(ctx context.Context, db DBTX) (int, error) {
	var n int
	err := db.QueryRow(ctx, `select count(*) from decisions where hold_status = 'pending'`).Scan(&n)
	return n, err
}

// OpenDecisions locks an account's decisions that still await a review, oldest first.
func OpenDecisions(ctx context.Context, db DBTX, accountID string) ([]*Decision, error) {
	rows, err := db.Query(ctx, `select `+decisionCols+` from decisions
		where account_id = $1 and review_status = 'open'
		order by occurred_at, decision_id for update`, accountID)
	if err != nil {
		return nil, err
	}
	return collectDecisions(rows)
}

// DecisionsByIDs locks the account's decisions with these IDs; IDs that aren't the
// account's are simply absent from the result.
func DecisionsByIDs(ctx context.Context, db DBTX, accountID string, ids []string) ([]*Decision, error) {
	rows, err := db.Query(ctx, `select `+decisionCols+` from decisions
		where account_id = $1 and decision_id = any($2::uuid[])
		order by occurred_at, decision_id for update`, accountID, ids)
	if err != nil {
		return nil, err
	}
	return collectDecisions(rows)
}

// RiskySignals are the hits that make "legitimate" a claim worth a second look:
// attacker infrastructure and blast radius rather than a new network alone.
var RiskySignals = []string{"young_domain", "lookalike_domain", "recipient_spike", "freemail_reply_to"}

// Warning is one risky signal among an account's open reviews, with one example.
type Warning struct {
	Signal string `json:"signal"`
	Detail string `json:"detail"`
}

// Warnings lists the risky signals on these decisions, one per signal name.
func Warnings(decisions []*Decision) []Warning {
	out := []Warning{}
	for _, d := range decisions {
		for _, h := range d.Hits {
			if slices.Contains(RiskySignals, h.Name) && !slices.ContainsFunc(out, func(w Warning) bool { return w.Signal == h.Name }) {
				out = append(out, Warning{h.Name, h.Detail})
			}
		}
	}
	return out
}

// ReviewedDecision is a non-allow decision an analyst or owner marked legitimate:
// what a correction to takeover can act on.
type ReviewedDecision struct {
	DecisionID string    `json:"decision_id"`
	OccurredAt time.Time `json:"occurred_at"`
	Action     string    `json:"action"`
	Score      int       `json:"score"`
	APIKeyID   *string   `json:"api_key_id"`
	Driver     string    `json:"primary_driver"`
}

// LegitimateDecisions lists an account's latest 50 such decisions, newest first.
func LegitimateDecisions(ctx context.Context, db DBTX, accountID string) ([]ReviewedDecision, error) {
	rows, err := db.Query(ctx, `select decision_id::text, occurred_at, action, score, api_key_id,
		coalesce((select h->>'name' from jsonb_array_elements(hits) h order by (h->>'points')::int desc, h->>'name' limit 1), 'No scored signals')
		from decisions where account_id = $1 and label = 'legitimate' and action <> 'allow'
		order by occurred_at desc, decision_id desc limit 50`, accountID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[ReviewedDecision])
}

// OpenCounts is what an account-level resolution would close. DecisionIDs are the
// open reviews; the resolution is refused if they change before it is submitted.
type OpenCounts struct {
	Reviews        int       `json:"reviews"`
	PendingHolds   int       `json:"pending_holds"`
	SuspendedKeys  int       `json:"suspended_keys"`
	RestorableKeys int       `json:"restorable_keys"`
	DecisionIDs    []string  `json:"decision_ids"`
	Warnings       []Warning `json:"warnings"` // risky signals: "legitimate" needs a typed confirmation
	// What the analyst is agreeing to, by name: the reviews themselves, the keys
	// suspended now, the ones a legitimate resolution may restore, and the keys the
	// reviews were sent with (what a takeover resolution suspends).
	List             []OpenReview `json:"list"`
	SuspendedKeyIDs  []string     `json:"suspended_key_ids"`
	RestorableKeyIDs []string     `json:"restorable_key_ids"`
	ReviewKeyIDs     []string     `json:"review_key_ids"`
	// The deadline: when the first pending hold among the open reviews is dropped
	// automatically. Nil when nothing is held.
	HoldsExpireAt *time.Time `json:"holds_expire_at"`
}

// OpenReview is one decision an account resolution would close.
type OpenReview struct {
	DecisionID string    `json:"decision_id"`
	OccurredAt time.Time `json:"occurred_at"`
	Action     string    `json:"action"`
	Score      int       `json:"score"`
	HoldStatus *string   `json:"hold_status"`
	// When a pending hold is dropped automatically if nobody decides (hold.expire_action).
	HoldExpiresAt *time.Time `json:"hold_expires_at"`
	APIKeyID      *string    `json:"api_key_id"`
	Driver        string     `json:"primary_driver"`
	Detail        string     `json:"detail"`
}

// AccountOpenCounts summarizes what resolving the account's open reviews would touch.
func AccountOpenCounts(ctx context.Context, db DBTX, accountID string) (OpenCounts, error) {
	var c OpenCounts
	err := db.QueryRow(ctx, `select
		(select count(*) from decisions where account_id = $1 and hold_status = 'pending'),
		coalesce((select array_agg(api_key_id order by api_key_id) from key_status where account_id = $1 and status = 'suspended'), '{}'),
		coalesce((select array_agg(k.api_key_id order by k.api_key_id) from key_status k where k.account_id = $1 and `+autoSuspendedKey+`
			and (k.decision_id in (select decision_id from decisions where account_id = $1 and review_status = 'open')
				or exists (select 1 from decisions kd where kd.decision_id = k.decision_id and kd.label = 'legitimate'))), '{}')`, accountID,
	).Scan(&c.PendingHolds, &c.SuspendedKeyIDs, &c.RestorableKeyIDs)
	if err != nil {
		return c, err
	}
	c.SuspendedKeys, c.RestorableKeys = len(c.SuspendedKeyIDs), len(c.RestorableKeyIDs)
	rows, err := db.Query(ctx, `select `+decisionCols+` from decisions
		where account_id = $1 and review_status = 'open' order by occurred_at, decision_id`, accountID)
	if err != nil {
		return c, err
	}
	open, err := collectDecisions(rows)
	if err != nil {
		return c, err
	}
	c.DecisionIDs, c.List, c.ReviewKeyIDs = []string{}, []OpenReview{}, []string{}
	for _, d := range open {
		r := OpenReview{DecisionID: d.DecisionID, OccurredAt: d.OccurredAt, Action: d.Action, Score: d.Score,
			HoldStatus: d.HoldStatus, APIKeyID: d.APIKeyID, Driver: "No scored signals"}
		if d.HoldStatus != nil && *d.HoldStatus == "pending" && d.HoldExpiresAt != nil {
			r.HoldExpiresAt = d.HoldExpiresAt
			if c.HoldsExpireAt == nil || d.HoldExpiresAt.Before(*c.HoldsExpireAt) {
				c.HoldsExpireAt = d.HoldExpiresAt
			}
		}
		if d.Reason != nil {
			r.Driver = *d.Reason
		} else if len(d.Hits) > 0 {
			top := slices.MaxFunc(d.Hits, func(a, b signal.Hit) int { return a.Points - b.Points })
			r.Driver, r.Detail = top.Name, top.Detail
		}
		c.DecisionIDs = append(c.DecisionIDs, d.DecisionID)
		c.List = append(c.List, r)
		if d.APIKeyID != nil && !slices.Contains(c.ReviewKeyIDs, *d.APIKeyID) {
			c.ReviewKeyIDs = append(c.ReviewKeyIDs, *d.APIKeyID)
		}
	}
	slices.Sort(c.ReviewKeyIDs)
	c.Reviews = len(c.DecisionIDs)
	c.Warnings = Warnings(open)
	return c, nil
}
