package store

import (
	"context"
	"time"

	"github.com/poojadesai14/accountguard/internal/event"
)

// InsertEvent stores the event's metadata and extracted features (never the body).
// inserted is false when event_id already exists.
func InsertEvent(ctx context.Context, db DBTX, ev *event.Event, f event.Features) (inserted bool, err error) {
	var changeKind, changeTarget, readResource *string
	var readStatus *int
	if ev.Change != nil {
		changeKind, changeTarget = &ev.Change.Kind, Nullable(ev.Change.TargetID)
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
		ev.EventID, ev.Type, ev.OccurredAt, ev.AccountID, Nullable(ev.APIKeyID), ev.Source,
		ev.Network.IP, ev.Network.ASN, Nullable(ev.Network.ASNOrg), Nullable(ev.Client.UserAgent),
		Nullable(f.SenderDomain), f.RecipientCount, nonNil(f.LinkDomains), nonNil(f.ReplyToDomains), nonNil(f.BodyEmailDomains),
		changeKind, changeTarget, readResource, readStatus,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
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
