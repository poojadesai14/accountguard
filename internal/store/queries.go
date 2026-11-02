package store

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/profile"
	"github.com/poojadesai14/resend-ato/internal/signal"
)

// DBTX is satisfied by both *pgxpool.Pool and pgx.Tx.
type DBTX interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

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

// InsertEvent stores the event's metadata and extracted features (never the body).
// inserted is false when event_id already exists.
func InsertEvent(ctx context.Context, db DBTX, ev *event.Event, f event.Features) (inserted bool, err error) {
	var changeKind, changeTarget, readResource *string
	var readStatus *int
	if ev.Change != nil {
		changeKind, changeTarget = &ev.Change.Kind, nullStr(ev.Change.TargetID)
	}
	if ev.Read != nil {
		readResource, readStatus = &ev.Read.Resource, &ev.Read.Status
	}
	tag, err := db.Exec(ctx, `
		insert into events (
			event_id, type, occurred_at, account_id, api_key_id, source,
			ip, asn, asn_org, user_agent,
			sender_domain, recipient_count, link_domains, reply_to_domains, body_email_domains,
			change_kind, change_target_id, read_resource, read_status)
		values ($1,$2,$3,$4,$5,$6, $7::text::inet,$8,$9,$10, $11,$12,$13,$14,$15, $16,$17,$18,$19)
		on conflict (event_id) do nothing`,
		ev.EventID, ev.Type, ev.OccurredAt, ev.AccountID, nullStr(ev.APIKeyID), ev.Source,
		ev.Network.IP, ev.Network.ASN, nullStr(ev.Network.ASNOrg), nullStr(ev.Client.UserAgent),
		nullStr(f.SenderDomain), f.RecipientCount, nonNil(f.LinkDomains), nonNil(f.ReplyToDomains), nonNil(f.BodyEmailDomains),
		changeKind, changeTarget, readResource, readStatus,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
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

// LockProfile creates the profile if needed and locks its row until the transaction ends,
// so concurrent events on one account can't lose baseline updates.
func LockProfile(ctx context.Context, tx pgx.Tx, accountID string, firstSeen time.Time) (*profile.Profile, error) {
	if _, err := tx.Exec(ctx,
		`insert into profiles (account_id, first_seen_at) values ($1, $2) on conflict do nothing`,
		accountID, firstSeen); err != nil {
		return nil, err
	}
	return scanProfile(tx.QueryRow(ctx, profileSelect+` for update`, accountID))
}

// GetProfile reads a profile without locking it. Returns pgx.ErrNoRows if the account is unknown.
func GetProfile(ctx context.Context, db DBTX, accountID string) (*profile.Profile, error) {
	return scanProfile(db.QueryRow(ctx, profileSelect, accountID))
}

const profileSelect = `
	select account_id, first_seen_at, events_seen, key_asns, known_domains, sender_domains,
	       used_freemail_reply_to, hourly_ewma, active_hours, hour_bucket_start, hour_bucket_recipients,
	       read_resources, last_change_at, last_first_read_at
	from profiles where account_id = $1`

func scanProfile(row pgx.Row) (*profile.Profile, error) {
	var p profile.Profile
	err := row.Scan(&p.AccountID, &p.FirstSeenAt, &p.EventsSeen, &p.KeyASNs, &p.KnownDomains, &p.SenderDomains,
		&p.UsedFreemailReplyTo, &p.HourlyEWMA, &p.ActiveHours, &p.HourBucketStart, &p.HourBucketRecipients,
		&p.ReadResources, &p.LastChangeAt, &p.LastFirstReadAt)
	if err != nil {
		return nil, err
	}
	p.Normalize()
	return &p, nil
}

func SaveProfile(ctx context.Context, db DBTX, p *profile.Profile) error {
	_, err := db.Exec(ctx, `
		update profiles set
			events_seen = $2, key_asns = $3, known_domains = $4, sender_domains = $5,
			used_freemail_reply_to = $6, hourly_ewma = $7, active_hours = $8, hour_bucket_start = $9,
			hour_bucket_recipients = $10, read_resources = $11, last_change_at = $12, last_first_read_at = $13,
			updated_at = now()
		where account_id = $1`,
		p.AccountID, p.EventsSeen, p.KeyASNs, p.KnownDomains, p.SenderDomains,
		p.UsedFreemailReplyTo, p.HourlyEWMA, p.ActiveHours, p.HourBucketStart,
		p.HourBucketRecipients, p.ReadResources, p.LastChangeAt, p.LastFirstReadAt)
	return err
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

// WindowRecipients sums recipients this account sent in (t-window, t], including events that
// weren't allowed: the attacker's own sends count toward the spike.
func WindowRecipients(ctx context.Context, db DBTX, accountID string, t time.Time, window time.Duration) (int, error) {
	var n int64
	err := db.QueryRow(ctx, `
		select coalesce(sum(recipient_count), 0) from events
		where account_id = $1 and type = 'email.send' and occurred_at > $2 and occurred_at <= $3`,
		accountID, t.Add(-window), t).Scan(&n)
	return int(n), err
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// OpenDecisions locks an account's decisions that still await a review, oldest first.
func OpenDecisions(ctx context.Context, db DBTX, accountID string) ([]*Decision, error) {
	rows, err := db.Query(ctx, `select `+decisionCols+` from decisions
		where account_id = $1 and review_status = 'open'
		order by occurred_at, decision_id for update`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Decision
	for rows.Next() {
		d, err := scanDecision(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
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
		) k order by source limit 1`, apiKeyID).Scan(&accountID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, false, nil
	}
	return accountID, status != nil && *status == "suspended", err == nil, err
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
	defer rows.Close()
	var out []*Decision
	for rows.Next() {
		d, err := scanDecision(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
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
}

// OpenReview is one decision an account resolution would close.
type OpenReview struct {
	DecisionID string    `json:"decision_id"`
	OccurredAt time.Time `json:"occurred_at"`
	Action     string    `json:"action"`
	Score      int       `json:"score"`
	HoldStatus *string   `json:"hold_status"`
	APIKeyID   *string   `json:"api_key_id"`
	Driver     string    `json:"primary_driver"`
	Detail     string    `json:"detail"`
}

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
	defer rows.Close()
	var open []*Decision
	for rows.Next() {
		d, err := scanDecision(rows)
		if err != nil {
			return c, err
		}
		open = append(open, d)
	}
	if err := rows.Err(); err != nil {
		return c, err
	}
	c.DecisionIDs, c.List, c.ReviewKeyIDs = []string{}, []OpenReview{}, []string{}
	for _, d := range open {
		r := OpenReview{DecisionID: d.DecisionID, OccurredAt: d.OccurredAt, Action: d.Action, Score: d.Score,
			HoldStatus: d.HoldStatus, APIKeyID: d.APIKeyID, Driver: "No scored signals"}
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
