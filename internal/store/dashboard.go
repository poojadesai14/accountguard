package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/poojadesai14/resend-ato/internal/signal"
)

type DashboardFilter struct {
	Segment, Query, Severity               string
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
	Metrics     DashboardMetrics   `json:"metrics"`
	Items       []DashboardAccount `json:"items"`
	Total       int                `json:"total"`
	Page        int                `json:"page"`
	Limit       int                `json:"limit"`
	GeneratedAt time.Time          `json:"generated_at"`
	EngineMode  string             `json:"engine_mode"`
}

// GetDashboard uses one statement snapshot for global counters, classification,
// filtering and pagination. Historical decisions and scores are never rewritten.
func GetDashboard(ctx context.Context, db DBTX, f DashboardFilter) (*Dashboard, error) {
	const query = `with ranked as (
 select d.*,
  count(*) filter (where review_status = 'open') over (partition by account_id) as open_reviews,
  first_value(action) over latest as latest_action,
  first_value(label) over latest as latest_label,
  row_number() over (partition by account_id order by
   (review_status = 'open') desc,
   case when review_status = 'open' then array_position(array['allow','flag','hold','block'],action) end desc nulls last,
   case when review_status = 'open' then score end desc nulls last,
   occurred_at desc, decided_at desc, decision_id desc) as position
 from decisions d
 window latest as (partition by account_id order by occurred_at desc, decided_at desc, decision_id desc)
 ), suspended as (
 select account_id, count(*)::int as suspended_keys from key_status where status = 'suspended' group by account_id
 ), cases as (
 select p.account_id, p.events_seen, p.active_hours,
  (p.events_seen >= $1 and p.active_hours >= $2) as baseline_ready,
  coalesce(d.open_reviews,0)::int as open_reviews, coalesce(s.suspended_keys,0) as suspended_keys,
  case when d.api_key_id is null then null else coalesce(k.status,'active') end as key_status,
  d.decision_id::text, d.event_id, d.api_key_id, d.action, d.score, d.enforced, d.label, d.review_status, d.hold_status, d.occurred_at,
  host(e.ip) as ip, e.asn, e.asn_org, coalesce(d.hits,'[]') as hits,
  coalesce(d.reason, (select h->>'name' from jsonb_array_elements(coalesce(d.hits,'[]')) h order by (h->>'points')::int desc, h->>'name' limit 1), 'No scored signals') as primary_driver,
  (coalesce(d.open_reviews,0) > 0 or coalesce(s.suspended_keys,0) > 0) as attention,
  coalesce(d.latest_action = 'allow' or d.latest_label = 'legitimate',false) as legitimate
 from profiles p
 left join ranked d on d.account_id = p.account_id and d.position = 1
 left join suspended s on s.account_id = p.account_id
 left join key_status k on k.api_key_id = d.api_key_id
 left join events e on e.event_id = d.event_id
 ), filtered as (
 select * from cases where
  (case when $4 = 'attention' then attention else not attention and legitimate end)
  and ($5 = 'all' or ($5 = 'high' and score >= 80) or ($5 = 'medium' and score between 40 and 79))
  and ($3 = '' or strpos(lower(concat_ws(' ', account_id, api_key_id, ip, asn::text, 'AS' || asn::text, asn_org, primary_driver,
   (select string_agg(replace(h->>'name','_',' '),' ') from jsonb_array_elements(hits) h), hits::text)),lower($3)) > 0)
 ), page as (
 select * from filtered order by array_position(array['allow','flag','hold','block'],action) desc nulls last,
 score desc nulls last, occurred_at desc nulls last, account_id limit $6 offset $7
 )
 select jsonb_build_object(
 'metrics', jsonb_build_object(
  'attention_accounts', (select count(*) from cases where attention),
  'pending_quarantines', (select count(*) from decisions where hold_status = 'pending'),
  'suspended_keys', (select count(*) from key_status where status = 'suspended'),
  'healthy_baselines', (select count(*) from cases where not attention and legitimate and baseline_ready)),
 'items', coalesce((select jsonb_agg(to_jsonb(page) - 'attention' - 'legitimate') from page),'[]'),
 'total', (select count(*) from filtered), 'page', $8::int, 'limit', $6::int, 'generated_at', statement_timestamp())`
	var raw []byte
	err := db.QueryRow(ctx, query, f.MinEvents, f.MinActiveHours, f.Query, f.Segment, f.Severity, f.Limit, (f.Page-1)*f.Limit, f.Page).Scan(&raw)
	if err != nil {
		return nil, err
	}
	var result Dashboard
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
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
