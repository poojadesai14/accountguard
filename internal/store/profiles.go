package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/accountguard/internal/profile"
)

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

// SaveProfile writes back a profile loaded with LockProfile.
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
