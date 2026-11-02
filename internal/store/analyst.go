package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/resend-ato/internal/signal"
)

// Range bounds a query by occurred_at. A nil end is open.
type Range struct {
	From, To *time.Time
}

// rangeSQL filters on col with $n (from) and $n+1 (to).
const rangeSQL = ` (%[1]s >= $%[2]d or $%[2]d::timestamptz is null) and (%[1]s < $%[3]d or $%[3]d::timestamptz is null) `

var severity = []string{"allow", "flag", "hold", "block"}

type Totals struct {
	Events int `json:"events"`
	Allow  int `json:"allow"`
	Flag   int `json:"flag"`
	Hold   int `json:"hold"`
	Block  int `json:"block"`
}

type StatsPoint struct {
	T     time.Time `json:"t"`
	Flag  int       `json:"flag"`
	Hold  int       `json:"hold"`
	Block int       `json:"block"`
}

type SignalCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type ReviewItem struct {
	AccountID string    `json:"account_id"`
	OpenCount int       `json:"open_count"`
	MaxAction string    `json:"max_action"`
	LastAt    time.Time `json:"last_at"`
}

type Stats struct {
	Totals      Totals        `json:"totals"`
	Series      []StatsPoint  `json:"series"`
	TopSignals  []SignalCount `json:"top_signals"`
	ReviewQueue []ReviewItem  `json:"review_queue"`
}

// GetStats aggregates decisions in r. bucket is "hour" or "day".
func GetStats(ctx context.Context, db DBTX, r Range, bucket string) (*Stats, error) {
	s := &Stats{Series: []StatsPoint{}, TopSignals: []SignalCount{}, ReviewQueue: []ReviewItem{}}

	err := db.QueryRow(ctx, `
		select count(*),
		       count(*) filter (where action = 'allow'), count(*) filter (where action = 'flag'),
		       count(*) filter (where action = 'hold'),  count(*) filter (where action = 'block')
		from decisions where`+fmt.Sprintf(rangeSQL, "occurred_at", 1, 2), r.From, r.To,
	).Scan(&s.Totals.Events, &s.Totals.Allow, &s.Totals.Flag, &s.Totals.Hold, &s.Totals.Block)
	if err != nil {
		return nil, err
	}

	rows, err := db.Query(ctx, `
		select date_trunc($3, occurred_at) as t,
		       count(*) filter (where action = 'flag') as flag,
		       count(*) filter (where action = 'hold') as hold,
		       count(*) filter (where action = 'block') as block
		from decisions where action <> 'allow' and`+fmt.Sprintf(rangeSQL, "occurred_at", 1, 2)+`
		group by 1 order by 1`, r.From, r.To, bucket)
	if err != nil {
		return nil, err
	}
	if s.Series, err = pgx.CollectRows(rows, pgx.RowToStructByName[StatsPoint]); err != nil {
		return nil, err
	}

	rows, err = db.Query(ctx, `
		select h->>'name' as name, count(*) as count
		from decisions, jsonb_array_elements(hits) h where`+fmt.Sprintf(rangeSQL, "occurred_at", 1, 2)+`
		group by 1 order by 2 desc, 1 limit 10`, r.From, r.To)
	if err != nil {
		return nil, err
	}
	if s.TopSignals, err = pgx.CollectRows(rows, pgx.RowToStructByName[SignalCount]); err != nil {
		return nil, err
	}

	rows, err = db.Query(ctx, `
		select account_id, count(*) as open_count,
		       max(array_position(array['allow','flag','hold','block'], action)) - 1 as sev,
		       max(occurred_at) as last_at
		from decisions where review_status = 'open' and`+fmt.Sprintf(rangeSQL, "occurred_at", 1, 2)+`
		group by account_id order by 3 desc, 4 desc limit 50`, r.From, r.To)
	if err != nil {
		return nil, err
	}
	s.ReviewQueue, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (ReviewItem, error) {
		var it ReviewItem
		var sev int
		err := row.Scan(&it.AccountID, &it.OpenCount, &sev, &it.LastAt)
		it.MaxAction = severity[sev]
		return it, err
	})
	return s, err
}

type AccountSummary struct {
	AccountID   string     `json:"account_id" db:"account_id"`
	FirstSeenAt time.Time  `json:"first_seen_at" db:"first_seen_at"`
	EventsSeen  int        `json:"events_seen" db:"events_seen"`
	Decisions   int        `json:"decisions" db:"decisions"`
	OpenReviews int        `json:"open_reviews" db:"open_reviews"`
	LastAt      *time.Time `json:"last_at" db:"last_at"`
	LastAction  *string    `json:"last_action" db:"last_action"`
}

func ListAccounts(ctx context.Context, db DBTX, q string, needsReview bool) ([]AccountSummary, error) {
	rows, err := db.Query(ctx, `
		select p.account_id, p.first_seen_at, p.events_seen,
		       coalesce(d.decisions, 0) as decisions, coalesce(d.open_reviews, 0) as open_reviews,
		       d.last_at, d.last_action
		from profiles p
		left join lateral (
			select count(*) as decisions,
			       count(*) filter (where review_status = 'open') as open_reviews,
			       max(occurred_at) as last_at,
			       (select action from decisions x where x.account_id = p.account_id
			        order by occurred_at desc, decided_at desc limit 1) as last_action
			from decisions where account_id = p.account_id
		) d on true
		-- strpos, not ilike: a typed % or _ is text, not a wildcard.
		where ($1 = '' or strpos(lower(p.account_id), lower($1)) > 0)
		  and (not $2 or coalesce(d.open_reviews, 0) > 0)
		order by open_reviews desc, d.last_at desc nulls last
		limit 200`, q, needsReview)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[AccountSummary])
}

// TimelineRow is one event with its decision. Bodies and addresses were never stored.
type TimelineRow struct {
	EventID          string       `json:"event_id" db:"event_id"`
	Type             string       `json:"type" db:"type"`
	OccurredAt       time.Time    `json:"occurred_at" db:"occurred_at"`
	APIKeyID         *string      `json:"api_key_id" db:"api_key_id"`
	Source           string       `json:"source" db:"source"`
	IP               *string      `json:"ip" db:"ip"`
	ASN              *int         `json:"asn" db:"asn"`
	ASNOrg           *string      `json:"asn_org" db:"asn_org"`
	UserAgent        *string      `json:"user_agent" db:"user_agent"`
	SenderDomain     *string      `json:"sender_domain" db:"sender_domain"`
	RecipientCount   int          `json:"recipient_count" db:"recipient_count"`
	LinkDomains      []string     `json:"link_domains" db:"link_domains"`
	ReplyToDomains   []string     `json:"reply_to_domains" db:"reply_to_domains"`
	BodyEmailDomains []string     `json:"body_email_domains" db:"body_email_domains"`
	ChangeKind       *string      `json:"change_kind" db:"change_kind"`
	ChangeTargetID   *string      `json:"change_target_id" db:"change_target_id"`
	ReadResource     *string      `json:"read_resource" db:"read_resource"`
	ReadStatus       *int         `json:"read_status" db:"read_status"`
	DecisionID       *string      `json:"decision_id" db:"decision_id"`
	Action           *string      `json:"action" db:"action"`
	Enforced         *bool        `json:"enforced" db:"enforced"`
	Score            *int         `json:"score" db:"score"`
	Hits             []signal.Hit `json:"hits" db:"hits"`
	Reason           *string      `json:"reason" db:"reason"`
	HoldStatus       *string      `json:"hold_status" db:"hold_status"`
	ReviewStatus     *string      `json:"review_status" db:"review_status"`
	Label            *string      `json:"label" db:"label"`
}

const timelineSelect = `
	select e.event_id, e.type, e.occurred_at, e.api_key_id, e.source, host(e.ip) as ip, e.asn, e.asn_org,
	       e.user_agent, e.sender_domain, e.recipient_count, e.link_domains,
	       e.reply_to_domains, e.body_email_domains, e.change_kind, e.change_target_id,
	       e.read_resource, e.read_status,
	       d.decision_id::text as decision_id, d.action, d.enforced, d.score, coalesce(d.hits, '[]') as hits,
	       d.reason, d.hold_status, d.review_status, d.label
	from events e left join decisions d using (event_id)`

// Timeline returns the latest limit events in r, oldest first.
func Timeline(ctx context.Context, db DBTX, accountID string, r Range, limit int) ([]TimelineRow, error) {
	rows, err := db.Query(ctx, `select * from (`+timelineSelect+`
		where e.account_id = $1 and`+fmt.Sprintf(rangeSQL, "e.occurred_at", 2, 3)+`
		order by e.occurred_at desc limit $4) t order by occurred_at`, accountID, r.From, r.To, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[TimelineRow])
}

func EventRow(ctx context.Context, db DBTX, eventID string) (*TimelineRow, error) {
	rows, err := db.Query(ctx, timelineSelect+` where e.event_id = $1`, eventID)
	if err != nil {
		return nil, err
	}
	row, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByName[TimelineRow])
	return &row, err
}

// SeriesEvent is the slim per-event row the account charts aggregate.
type SeriesEvent struct {
	OccurredAt     time.Time    `db:"occurred_at"`
	Type           string       `db:"type"`
	RecipientCount int          `db:"recipient_count"`
	ASN            *int         `db:"asn"`
	ASNOrg         string       `db:"asn_org"`
	ASNFirstSeen   time.Time    `db:"asn_first_seen"`
	Action         string       `db:"action"`
	Hits           []signal.Hit `db:"hits"`
}

// SeriesEvents returns events in r with the first time the account ever used each ASN
// (computed over all history, not just r).
func SeriesEvents(ctx context.Context, db DBTX, accountID string, r Range) ([]SeriesEvent, error) {
	rows, err := db.Query(ctx, `
		select e.occurred_at, e.type, e.recipient_count, e.asn, coalesce(e.asn_org, '') as asn_org,
		       e.asn_first_seen, coalesce(d.action, '') as action, coalesce(d.hits, '[]') as hits
		from (select *, min(occurred_at) over (partition by asn) as asn_first_seen
		      from events where account_id = $1) e
		left join decisions d using (event_id)
		where`+fmt.Sprintf(rangeSQL, "e.occurred_at", 2, 3)+`
		order by e.occurred_at`, accountID, r.From, r.To)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[SeriesEvent])
}

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

func KeyStatuses(ctx context.Context, db DBTX, accountID string) ([]KeyStatus, error) {
	rows, err := db.Query(ctx, `
		select api_key_id, account_id, status, reason, decision_id::text as decision_id, updated_at,
			`+takeoverOnAccount+` as takeover
		from key_status where account_id = $1 order by updated_at desc`, accountID)
	if err != nil {
		return nil, err
	}
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
	defer rows.Close()
	var stops []*Decision
	for rows.Next() {
		d, err := scanDecision(rows)
		if err != nil {
			return nil, err
		}
		stops = append(stops, d)
	}
	return Warnings(stops), rows.Err()
}

type AnalystAction struct {
	ID         int64     `json:"id" db:"id"`
	DecisionID *string   `json:"decision_id" db:"decision_id"`
	APIKeyID   *string   `json:"api_key_id" db:"api_key_id"`
	Action     string    `json:"action" db:"action"`
	Actor      string    `json:"actor" db:"actor"`
	Reason     string    `json:"reason" db:"reason"`
	CreatedAt  time.Time `json:"created_at" db:"created_at"`
}

func ActionsForDecision(ctx context.Context, db DBTX, decisionID string) ([]AnalystAction, error) {
	rows, err := db.Query(ctx, `
		select id, decision_id::text as decision_id, api_key_id, action, actor, reason, created_at
		from analyst_actions where decision_id = $1::uuid order by created_at`, decisionID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[AnalystAction])
}

func InsertAnalystAction(ctx context.Context, db DBTX, decisionID, apiKeyID *string, action, actor, reason string) error {
	_, err := db.Exec(ctx, `
		insert into analyst_actions (decision_id, api_key_id, action, actor, reason)
		values ($1::uuid, $2, $3, $4, $5)`, decisionID, apiKeyID, action, actor, reason)
	return err
}

// DecisionByID loads a decision; forUpdate locks it for the rest of the transaction.
func DecisionByID(ctx context.Context, db DBTX, decisionID string, forUpdate bool) (*Decision, error) {
	q := `select ` + decisionCols + ` from decisions where decision_id = $1::uuid`
	if forUpdate {
		q += ` for update`
	}
	return scanDecision(db.QueryRow(ctx, q, decisionID))
}

// ExpireHolds marks pending holds past their expiry as expired. They stay open for review.
func ExpireHolds(ctx context.Context, db DBTX) (int64, error) {
	tag, err := db.Exec(ctx, `
		update decisions set hold_status = 'expired'
		where hold_status = 'pending' and hold_expires_at < now()`)
	return tag.RowsAffected(), err
}

func PendingHolds(ctx context.Context, db DBTX) (int, error) {
	var n int
	err := db.QueryRow(ctx, `select count(*) from decisions where hold_status = 'pending'`).Scan(&n)
	return n, err
}
