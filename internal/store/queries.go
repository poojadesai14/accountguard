package store

import (
	"context"
	"errors"
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

// SuspendKey suspends one API key. The account and its other keys keep working.
func SuspendKey(ctx context.Context, db DBTX, apiKeyID, accountID, reason, decisionID string) error {
	_, err := db.Exec(ctx, `
		insert into key_status (api_key_id, account_id, status, reason, decision_id)
		values ($1, $2, 'suspended', $3, $4::uuid)
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
