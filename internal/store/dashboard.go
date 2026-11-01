package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/poojadesai14/resend-ato/internal/signal"
)

type DashboardFilter struct {
	Segment, Query, Severity, Sort, View   string
	Page, Limit, MinEvents, MinActiveHours int
}
type DashboardMetrics struct {
	AttentionAccounts  int `json:"attention_accounts"`
	PendingQuarantines int `json:"pending_quarantines"`
	SuspendedKeys      int `json:"suspended_keys"`
	HealthyBaselines   int `json:"healthy_baselines"`
}
type DashboardAccount struct {
	AccountID     string       `json:"account_id"`
	EventsSeen    int          `json:"events_seen"`
	ActiveHours   int          `json:"active_hours"`
	BaselineReady bool         `json:"baseline_ready"`
	OpenReviews   int          `json:"open_reviews"`
	SuspendedKeys int          `json:"suspended_keys"`
	KeyStatus     *string      `json:"key_status"`
	DecisionID    *string      `json:"decision_id"`
	EventID       *string      `json:"event_id"`
	APIKeyID      *string      `json:"api_key_id"`
	Action        *string      `json:"action"`
	Score         *int         `json:"score"`
	Enforced      *bool        `json:"enforced"`
	Label         *string      `json:"label"`
	ReviewStatus  *string      `json:"review_status"`
	HoldStatus    *string      `json:"hold_status"`
	OccurredAt    *time.Time   `json:"occurred_at"`
	IP            *string      `json:"ip"`
	ASN           *int         `json:"asn"`
	ASNOrg        *string      `json:"asn_org"`
	PrimaryDriver string       `json:"primary_driver"`
	Hits          []signal.Hit `json:"hits"`
}
type Dashboard struct {
	View        string             `json:"view"`
	Metrics     DashboardMetrics   `json:"metrics"`
	Items       []DashboardAccount `json:"items"`
	Total       int                `json:"total"`
	Page        int                `json:"page"`
	Limit       int                `json:"limit"`
	GeneratedAt time.Time          `json:"generated_at"`
	EngineMode  string             `json:"engine_mode"`
}

// GetDashboard uses one statement snapshot for global counters and filtered,
// paginated account, held-event, or suspended-key rows. Historical decisions and
// scores are never rewritten.
func GetDashboard(ctx context.Context, db DBTX, f DashboardFilter) (*Dashboard, error) {
	if f.View == "" {
		f.View = "accounts"
	}
	const query = `with ranked as (
 select d.*,
  count(*) filter (where review_status = 'open') over (partition by account_id) as open_reviews,
  first_value(action) over latest as latest_action,
  first_value(label) over latest as latest_label,
  row_number() over (partition by account_id order by
   (review_status = 'open') desc,
   case when review_status = 'open' then array_position(array['allow','flag','hold','block'],action) end desc nulls last,
   case when review_status = 'open' then score end desc nulls last,
   occurred_at desc, decided_at desc, decision_id desc) as position,
  row_number() over (partition by account_id, api_key_id order by
   (review_status = 'open') desc,
   case when review_status = 'open' then array_position(array['allow','flag','hold','block'],action) end desc nulls last,
   case when review_status = 'open' then score end desc nulls last,
   occurred_at desc, decided_at desc, decision_id desc) as key_position
 from decisions d
 window latest as (partition by account_id order by occurred_at desc, decided_at desc, decision_id desc)
 ), suspended as (
 select account_id, count(*)::int as suspended_keys from key_status where status = 'suspended' group by account_id
 ), entities as (
 select 'accounts'::text as kind, account_id, null::uuid as decision_id, null::text as key_id from profiles
 union all
 select 'holds', account_id, decision_id, null::text from decisions where $10 = 'holds' and hold_status = 'pending'
 union all
 select 'keys', account_id, null::uuid, api_key_id from key_status where $10 = 'keys' and status = 'suspended'
 ), cases as (
 select ent.kind as entity_kind, ent.account_id, coalesce(p.events_seen,0) as events_seen, coalesce(p.active_hours,0) as active_hours,
  (coalesce(p.events_seen,0) >= $1 and coalesce(p.active_hours,0) >= $2) as baseline_ready,
  coalesce(a.open_reviews,0)::int as open_reviews, coalesce(s.suspended_keys,0) as suspended_keys,
  case when coalesce(ent.key_id,d.api_key_id) is null then null else coalesce(k.status,'active') end as key_status,
  d.decision_id::text, d.event_id, coalesce(ent.key_id,d.api_key_id) as api_key_id, d.action, d.score, d.enforced, d.label, d.review_status, d.hold_status, d.occurred_at,
  host(e.ip) as ip, e.asn, e.asn_org, coalesce(d.hits,'[]') as hits,
  coalesce(d.reason, (select h->>'name' from jsonb_array_elements(coalesce(d.hits,'[]')) h order by (h->>'points')::int desc, h->>'name' limit 1), 'No scored signals') as primary_driver,
  (coalesce(a.open_reviews,0) > 0 or coalesce(s.suspended_keys,0) > 0) as attention,
  coalesce(a.latest_action = 'allow' or a.latest_label = 'legitimate',false) as legitimate
 from entities ent
 left join profiles p on p.account_id = ent.account_id
 left join ranked a on a.account_id = ent.account_id and a.position = 1
 left join ranked d on d.account_id = ent.account_id and
  (case when ent.kind = 'holds' then d.decision_id = ent.decision_id
   when ent.kind = 'keys' then d.api_key_id = ent.key_id and d.key_position = 1
   else d.position = 1 end)
 left join suspended s on s.account_id = ent.account_id
 left join key_status k on k.api_key_id = coalesce(ent.key_id,d.api_key_id)
 left join events e on e.event_id = d.event_id
 ), filtered as (
 select * from cases where
  entity_kind = (case when $10 = 'healthy' then 'accounts' else $10 end)
  and (case when $10 in ('holds','keys') then true when $4 = 'attention' then attention else not attention and legitimate end)
  and ($10 <> 'healthy' or baseline_ready)
  and ($5 = 'all' or action = $5)
  and ($3 = '' or strpos(lower(concat_ws(' ', account_id, api_key_id, ip, asn::text, 'AS' || asn::text, asn_org, primary_driver,
   (select string_agg(replace(h->>'name','_',' '),' ') from jsonb_array_elements(hits) h), hits::text)),lower($3)) > 0)
 ), page as (
 select * from filtered order by
 case when $9 = 'score_desc' then score end desc nulls last,
 array_position(array['allow','flag','hold','block'],action) desc nulls last,
 score desc nulls last, occurred_at desc nulls last, account_id, api_key_id nulls last, decision_id nulls last limit $6 offset $7
 )
 select jsonb_build_object(
 'metrics', jsonb_build_object(
  'attention_accounts', (select count(*) from cases where entity_kind = 'accounts' and attention),
  'pending_quarantines', (select count(*) from decisions where hold_status = 'pending'),
  'suspended_keys', (select count(*) from key_status where status = 'suspended'),
  'healthy_baselines', (select count(*) from cases where entity_kind = 'accounts' and not attention and legitimate and baseline_ready)),
 'items', coalesce((select jsonb_agg(to_jsonb(page) - 'attention' - 'legitimate' - 'entity_kind') from page),'[]'),
 'total', (select count(*) from filtered), 'page', $8::int, 'limit', $6::int, 'generated_at', statement_timestamp())`
	var raw []byte
	err := db.QueryRow(ctx, query, f.MinEvents, f.MinActiveHours, f.Query, f.Segment, f.Severity, f.Limit, (f.Page-1)*f.Limit, f.Page, f.Sort, f.View).Scan(&raw)
	if err != nil {
		return nil, err
	}
	var result Dashboard
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	result.View = f.View
	return &result, nil
}

type GlobalAnalystAction struct {
	AnalystAction
	AccountID *string `json:"account_id"`
}
type AnalystActionPage struct {
	Items        []GlobalAnalystAction `json:"items"`
	NextBeforeID *int64                `json:"next_before_id"`
}

func ListAnalystActions(ctx context.Context, db DBTX, r Range, beforeID int64, limit int) (*AnalystActionPage, error) {
	rows, err := db.Query(ctx, `select a.id, a.decision_id::text, a.api_key_id, a.action, a.actor, a.reason, a.created_at,
 coalesce(d.account_id,k.account_id) as account_id
 from analyst_actions a left join decisions d on d.decision_id = a.decision_id
 left join key_status k on k.api_key_id = a.api_key_id
 where `+fmtRangeAudit+` and ($3::bigint = 0 or a.id < $3)
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

const fmtRangeAudit = `(a.created_at >= $1 or $1::timestamptz is null) and (a.created_at < $2 or $2::timestamptz is null)`
