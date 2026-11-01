package store

import (
	"context"
	"encoding/json"
	"time"
)

// RelatedAccount is another account that used the same indicator.
type RelatedAccount struct {
	AccountID   string    `json:"account_id"`
	Events      int       `json:"events"`
	WorstAction string    `json:"worst_action"`
	Confirmed   bool      `json:"confirmed"` // an analyst confirmed a takeover on this account
	DecisionID  string    `json:"decision_id"`
	LastAt      time.Time `json:"last_at"`
}

// RelatedIndicator summarizes one link domain, Reply-To domain or IP across other accounts.
type RelatedIndicator struct {
	Kind      string           `json:"kind"` // link_domain | reply_to_domain | ip
	Value     string           `json:"value"`
	Accounts  int              `json:"accounts"`
	Events    int              `json:"events"`
	Stopped   int              `json:"stopped"` // accounts where one of these events was held or blocked
	Confirmed int              `json:"confirmed"`
	Top       []RelatedAccount `json:"top"` // most severe first, at most RelatedTop
}

// RelatedTop caps how many accounts are listed per indicator. The UI shows five and
// expands to the rest; counts always cover every account, listed or not.
const RelatedTop = 50

// RelatedIndicators finds other accounts that used the event's link domains, non-freemail
// Reply-To domains or IP within window either side of it. ASNs are left out on purpose:
// a cloud ASN is shared by thousands of legitimate senders.
func RelatedIndicators(ctx context.Context, db DBTX, accountID string, ev *TimelineRow, freemail map[string]bool, window time.Duration) ([]RelatedIndicator, error) {
	replyTo := make([]string, 0, len(ev.ReplyToDomains))
	for _, d := range ev.ReplyToDomains {
		if !freemail[d] {
			replyTo = append(replyTo, d)
		}
	}
	if len(ev.LinkDomains) == 0 && len(replyTo) == 0 && ev.IP == nil {
		return []RelatedIndicator{}, nil
	}
	// Three separate lookups so each can use its own index.
	const query = `with hits as (
  select 'link_domain' as kind, d.value, e.account_id, e.event_id, e.occurred_at
  from unnest($1::text[]) as d(value)
  join events e on e.link_domains @> array[d.value]
  where e.account_id <> $4 and e.occurred_at between $5::timestamptz - $6::interval and $5::timestamptz + $6::interval
  union all
  select 'reply_to_domain', d.value, e.account_id, e.event_id, e.occurred_at
  from unnest($2::text[]) as d(value)
  join events e on e.reply_to_domains @> array[d.value]
  where e.account_id <> $4 and e.occurred_at between $5::timestamptz - $6::interval and $5::timestamptz + $6::interval
  union all
  select 'ip', host(e.ip), e.account_id, e.event_id, e.occurred_at
  from events e
  where $3::inet is not null and e.ip = $3::inet
    and e.account_id <> $4 and e.occurred_at between $5::timestamptz - $6::interval and $5::timestamptz + $6::interval
), per_account as (
  select h.kind, h.value, h.account_id, count(*)::int as events, max(h.occurred_at) as last_at,
    coalesce((array_agg(d.action order by array_position(array['allow','flag','hold','block'], d.action) desc nulls last, d.score desc nulls last))[1], 'allow') as worst_action,
    (array_agg(d.decision_id::text order by array_position(array['allow','flag','hold','block'], d.action) desc nulls last, d.rejected asc nulls first, d.score desc nulls last, h.occurred_at desc))[1] as decision_id,
    exists(select 1 from decisions c where c.account_id = h.account_id and c.label = 'takeover') as confirmed
  -- A key_suspended rejection says the key was already suspended for something
  -- else, not that this indicator was stopped; count those events as allowed.
  from hits h left join (
    select decision_id, event_id, score, reason = 'key_suspended' as rejected,
      case when reason = 'key_suspended' then 'allow' else action end as action
    from decisions
  ) d on d.event_id = h.event_id
  group by h.kind, h.value, h.account_id
), ranked as (
  select *, row_number() over (partition by kind, value order by confirmed desc,
    array_position(array['allow','flag','hold','block'], worst_action) desc, last_at desc, account_id) as position
  from per_account
)
select coalesce(jsonb_agg(i order by i.stopped desc, i.accounts desc, i.kind, i.value), '[]') from (
  select kind, value, count(*)::int as accounts, sum(events)::int as events,
    count(*) filter (where worst_action in ('hold','block'))::int as stopped,
    count(*) filter (where confirmed)::int as confirmed,
    jsonb_agg(jsonb_build_object('account_id', account_id, 'events', events, 'worst_action', worst_action,
      'confirmed', confirmed, 'decision_id', decision_id, 'last_at', last_at) order by position)
      filter (where position <= $7) as top
  from ranked group by kind, value
) i`
	var raw []byte
	if err := db.QueryRow(ctx, query, ev.LinkDomains, replyTo, ev.IP, accountID, ev.OccurredAt, window, RelatedTop).Scan(&raw); err != nil {
		return nil, err
	}
	var out []RelatedIndicator
	return out, json.Unmarshal(raw, &out)
}
