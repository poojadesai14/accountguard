package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/accountguard/internal/action"
	"github.com/poojadesai14/accountguard/internal/signal"
)

// DashboardFilter selects and pages the dashboard's rows. The API validates it.
type DashboardFilter struct {
	Segment, Query, Severity, Sort, View   string
	Page, Limit, MinEvents, MinActiveHours int
}

// DashboardMetrics are the counters across the top of the dashboard, unfiltered.
type DashboardMetrics struct {
	AttentionAccounts  int `json:"attention_accounts"`
	PendingQuarantines int `json:"pending_quarantines"`
	SuspendedKeys      int `json:"suspended_keys"`
	FlaggedAccounts    int `json:"flagged_accounts"`
	HealthyBaselines   int `json:"healthy_baselines"`
}

// DashboardAccount is one dashboard row: an account, a held event or a suspended
// key, with the decision that best explains it.
type DashboardAccount struct {
	AccountID     string     `json:"account_id"`
	EventsSeen    int        `json:"events_seen"`
	ActiveHours   int        `json:"active_hours"`
	BaselineReady bool       `json:"baseline_ready"`
	OpenReviews   int        `json:"open_reviews"`
	SuspendedKeys int        `json:"suspended_keys"`
	KeyStatus     *string    `json:"key_status"`
	DecisionID    *string    `json:"decision_id"`
	EventID       *string    `json:"event_id"`
	APIKeyID      *string    `json:"api_key_id"`
	Action        *string    `json:"action"`
	Score         *int       `json:"score"`
	Enforced      *bool      `json:"enforced"`
	Label         *string    `json:"label"`
	ReviewStatus  *string    `json:"review_status"`
	HoldStatus    *string    `json:"hold_status"`
	HoldExpiresAt *time.Time `json:"hold_expires_at"`
	// What the decision was about: email.send, account.change or api.read. Holds
	// can be on account changes too, so the UI must not assume an email.
	EventType  *string `json:"event_type"`
	ChangeKind *string `json:"change_kind"`
	// Set only while the row's key is suspended: who suspended it (auto, analyst
	// or owner) and when.
	KeySuspendedBy *string    `json:"key_suspended_by"`
	KeySuspendedAt *time.Time `json:"key_suspended_at"`
	// The row's decision suspended its key and was since marked legitimate, nothing
	// on the account is open, and every suspended key on it is in that state
	// (suspendedForLegitimate): restoring is the step left.
	RestorePending bool         `json:"restore_pending"`
	OccurredAt     *time.Time   `json:"occurred_at"`
	IP             *string      `json:"ip"`
	ASN            *int         `json:"asn"`
	ASNOrg         *string      `json:"asn_org"`
	PrimaryDriver  string       `json:"primary_driver"`
	Hits           []signal.Hit `json:"hits"`
}

// Dashboard is one page of rows and the global counters, from one snapshot.
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

// GetDashboard reads the global counters and one filtered page of account,
// held-event or suspended-key rows in a single statement, so they agree.
// Historical decisions and scores are never rewritten.
func GetDashboard(ctx context.Context, db DBTX, f DashboardFilter) (*Dashboard, error) {
	if f.View == "" {
		f.View = "accounts"
	}
	var raw []byte
	err := db.QueryRow(ctx, dashboardQuery, pgx.NamedArgs{
		"view":             f.View,
		"segment":          f.Segment,
		"severity":         f.Severity,
		"search":           f.Query,
		"sort":             f.Sort,
		"min_events":       f.MinEvents,
		"min_active_hours": f.MinActiveHours,
		"page":             f.Page,
		"limit":            f.Limit,
		"offset":           (f.Page - 1) * f.Limit,
	}).Scan(&raw)
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

// The dashboard query is built from one CTE per step:
//
//	ranked    every decision, ranked within its account and within its key
//	suspended suspended keys per account, and how many only wait for a restore
//	entities  the rows a view lists: accounts, pending holds or suspended keys
//	cases     each entity with the decision that explains it and its flags
//	filtered  the cases the view, segment, severity and search select
//	page      one sorted page of them
const dashboardQuery = `with
ranked as (` + dashboardRanked + `),
suspended as (` + dashboardSuspended + `),
entities as (` + dashboardEntities + `),
cases as (` + dashboardCases + `),
filtered as (` + dashboardFiltered + `),
page as (` + dashboardPage + `)
` + dashboardResult

// reviewPriority orders an account's (or key's) decisions so the first is the one
// to show: open before resolved, then the most severe and highest-scoring open
// one, then the newest. Follow-on key_suspended rejections rank below every scored
// decision, even a resolved one: they are a consequence of a suspension, never the
// evidence for it, and they stay open after an analyst has confirmed the
// triggering block.
const reviewPriority = `(reason = 'key_suspended') asc nulls first,
  (review_status = 'open') desc,
  case when review_status = 'open' then array_position(` + action.SeveritySQL + `, action) end desc nulls last,
  case when review_status = 'open' then score end desc nulls last,
  occurred_at desc, decided_at desc, decision_id desc`

// dashboardRanked: position 1 is the decision an account row shows, key_position 1
// the one a key row shows. "Is the account legitimate now?" looks at its latest
// scored decision: a later key_suspended rejection only says the key was still
// suspended at the time.
const dashboardRanked = `
 select d.*,
  count(*) filter (where review_status = 'open') over (partition by account_id) as open_reviews,
  first_value(action) over latest_scored as latest_action,
  first_value(label) over latest_scored as latest_label,
  row_number() over (partition by account_id order by ` + reviewPriority + `) as position,
  row_number() over (partition by account_id, api_key_id order by ` + reviewPriority + `) as key_position
 from decisions d
 window latest_scored as (partition by account_id order by (reason = 'key_suspended') asc nulls first, occurred_at desc, decided_at desc, decision_id desc)
`

const dashboardSuspended = `
 select k.account_id, count(*)::int as suspended_keys,
  count(*) filter (where ` + suspendedForLegitimate + `)::int as restore_pending_keys
 from key_status k where k.status = 'suspended' group by k.account_id
`

// dashboardEntities lists every account, plus pending holds or suspended keys
// when the view asks for them.
const dashboardEntities = `
 select 'accounts'::text as kind, account_id, null::uuid as decision_id, null::text as key_id from profiles
 union all
 select 'holds', account_id, decision_id, null::text from decisions where @view = 'holds' and hold_status = 'pending'
 union all
 select 'keys', account_id, decision_id, api_key_id from key_status where @view = 'keys' and status = 'suspended'
`

// restorePending: the row shows the decision that suspended its key (so its badge,
// key, driver and time all describe that decision), nothing on the account is open,
// and every suspended key on it waits only for a restore (suspendedForLegitimate),
// so "restore to finish" is true.
const restorePending = `(d.decision_id = k.decision_id and coalesce(a.open_reviews,0) = 0
  and coalesce(s.suspended_keys,0) > 0 and s.restore_pending_keys = s.suspended_keys)`

// dashboardCases joins each entity to its account's top decision (a) and to the
// decision the row shows (d): the hold itself, the decision that suspended the
// key, or the account's top one. attention and legitimate pick the segment.
const dashboardCases = `
 select ent.kind as entity_kind, ent.account_id, coalesce(p.events_seen,0) as events_seen, coalesce(p.active_hours,0) as active_hours,
  (coalesce(p.events_seen,0) >= @min_events and coalesce(p.active_hours,0) >= @min_active_hours) as baseline_ready,
  coalesce(a.open_reviews,0)::int as open_reviews, coalesce(s.suspended_keys,0) as suspended_keys,
  case when coalesce(ent.key_id,d.api_key_id) is null then null else coalesce(k.status,'active') end as key_status,
  d.decision_id::text, d.event_id, coalesce(ent.key_id,d.api_key_id) as api_key_id, d.action, d.score, d.enforced, d.label, d.review_status, d.hold_status, d.hold_expires_at, d.occurred_at,
  case when k.status = 'suspended' then k.reason end as key_suspended_by,
  case when k.status = 'suspended' then k.updated_at end as key_suspended_at,
  ` + restorePending + ` as restore_pending,
  host(e.ip) as ip, e.asn, e.asn_org, e.type as event_type, e.change_kind, coalesce(d.hits,'[]') as hits,
  coalesce(d.reason, (select h->>'name' from jsonb_array_elements(coalesce(d.hits,'[]')) h order by (h->>'points')::int desc, h->>'name' limit 1), 'No scored signals') as primary_driver,
  (coalesce(a.open_reviews,0) > 0 or coalesce(s.suspended_keys,0) > 0) as attention,
  coalesce(a.latest_action = 'allow' or a.latest_label = 'legitimate',false) as legitimate,
  coalesce(a.latest_action = 'flag' and a.latest_label is distinct from 'legitimate',false) as flagged
 from entities ent
 left join profiles p on p.account_id = ent.account_id
 left join ranked a on a.account_id = ent.account_id and a.position = 1
 left join ranked d on d.account_id = ent.account_id and
  (case when ent.kind = 'holds' then d.decision_id = ent.decision_id
   -- A key row shows the decision that suspended it. Later sends on a suspended key
   -- are blocked as key_suspended and must not pose as the cause.
   when ent.kind = 'keys' and ent.decision_id is not null then d.decision_id = ent.decision_id
   when ent.kind = 'keys' then d.api_key_id = ent.key_id and d.key_position = 1
   else d.position = 1 end)
 left join suspended s on s.account_id = ent.account_id
 left join key_status k on k.api_key_id = coalesce(ent.key_id,d.api_key_id)
 left join events e on e.event_id = d.event_id
`

// dashboardFiltered: the healthy view is the accounts view's baseline segment,
// limited to accounts with a ready baseline. The flagged view lists accounts whose
// latest decision was a flag and that have nothing to review: flags send the
// email and open no review, so these accounts are in no other view. Search matches IDs, network, driver
// and hit names and details, case-insensitively.
const dashboardFiltered = `
 select * from cases where
  entity_kind = (case when @view in ('healthy','flagged') then 'accounts' else @view end)
  and (case when @view in ('holds','keys') then true when @view = 'flagged' then not attention and flagged
   when @segment = 'attention' then attention else not attention and legitimate end)
  and (@view <> 'healthy' or baseline_ready)
  and (@severity = 'all' or action = @severity)
  and (@search = '' or strpos(lower(concat_ws(' ', account_id, api_key_id, ip, asn::text, 'AS' || asn::text, asn_org,
   primary_driver, replace(primary_driver,'_',' '),
   (select string_agg(concat_ws(' ', h->>'name', replace(h->>'name','_',' '), h->>'detail'),' ') from jsonb_array_elements(hits) h))),lower(@search)) > 0)
`

const dashboardPage = `
 select * from filtered order by
 case when @sort = 'recent' then occurred_at end desc nulls last,
 array_position(` + action.SeveritySQL + `,action) desc nulls last,
 score desc nulls last, occurred_at desc nulls last, account_id, api_key_id nulls last, decision_id nulls last limit @limit offset @offset
`

// dashboardResult builds the Dashboard JSON. The counters ignore the filters.
const dashboardResult = `
 select jsonb_build_object(
 'metrics', jsonb_build_object(
  'attention_accounts', (select count(*) from cases where entity_kind = 'accounts' and attention),
  'pending_quarantines', (select count(*) from decisions where hold_status = 'pending'),
  'suspended_keys', (select count(*) from key_status where status = 'suspended'),
  'flagged_accounts', (select count(*) from cases where entity_kind = 'accounts' and not attention and flagged),
  'healthy_baselines', (select count(*) from cases where entity_kind = 'accounts' and not attention and legitimate and baseline_ready)),
 'items', coalesce((select jsonb_agg(to_jsonb(page) - 'attention' - 'legitimate' - 'flagged' - 'entity_kind') from page),'[]'),
 'total', (select count(*) from filtered), 'page', @page::int, 'limit', @limit::int, 'generated_at', statement_timestamp())`
