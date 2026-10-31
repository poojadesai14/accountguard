export type Action = "allow" | "flag" | "hold" | "block";
export type Hit = {
  name: string;
  category: string;
  points: number;
  detail: string;
};
export type StatsPoint = {
  t: string;
  flag: number;
  hold: number;
  block: number;
};
export type ReviewItem = {
  account_id: string;
  open_count: number;
  max_action: Action;
  last_at: string;
};
export type Stats = {
  totals: {
    events: number;
    allow: number;
    flag: number;
    hold: number;
    block: number;
  };
  series: StatsPoint[] | null;
  top_signals: { name: string; count: number }[] | null;
  review_queue: ReviewItem[] | null;
};
export type AccountSummary = {
  account_id: string;
  first_seen_at: string;
  events_seen: number;
  decisions: number;
  open_reviews: number;
  last_at: string | null;
  last_action: Action | null;
};
export type Profile = {
  account_id: string;
  first_seen_at: string;
  events_seen: number;
  key_asns: Record<string, Record<string, number>>;
  known_domains: Record<string, number>;
  sender_domains: string[];
  used_freemail_reply_to: boolean;
  hourly_ewma: number;
  active_hours: number;
  read_resources: string[];
  last_change_at: string | null;
};
export type KeyStatus = {
  api_key_id: string;
  account_id: string;
  status: "active" | "suspended";
  reason: string;
  decision_id: string | null;
  updated_at: string;
};
export type ProfileResponse = {
  profile: Profile;
  key_status: KeyStatus[] | null;
};
export type TimelineRow = {
  event_id: string;
  type: string;
  occurred_at: string;
  api_key_id: string | null;
  source: string;
  ip: string | null;
  asn: number | null;
  asn_org: string | null;
  user_agent: string | null;
  sender_domain: string | null;
  recipient_count: number;
  link_domains: string[];
  reply_to_domains: string[];
  body_email_domains: string[];
  change_kind: string | null;
  change_target_id: string | null;
  read_resource: string | null;
  read_status: number | null;
  decision_id: string | null;
  action: Action | null;
  enforced: boolean | null;
  score: number | null;
  hits: Hit[];
  reason: string | null;
  hold_status: string | null;
  review_status: string | null;
  label: string | null;
};
export type SeriesPoint = {
  t: string;
  recipients: number;
  asns: { asn: number; org: string; first_seen: boolean }[];
  content_hits: string[];
  account_changes: number;
  actions: Partial<Record<Action, number>>;
};
export type AccountSeries = {
  account_id: string;
  baseline_hourly: number;
  spike_threshold: number;
  points: SeriesPoint[];
};
export type Decision = {
  decision_id: string;
  event_id: string;
  account_id: string;
  api_key_id: string | null;
  occurred_at: string;
  decided_at: string;
  action: Action;
  enforced: boolean;
  score: number;
  hits: Hit[];
  reason: string | null;
  config_version: string;
  latency_us: number;
  hold_status: string | null;
  hold_expires_at: string | null;
  review_status: string;
  label: string | null;
};
export type AuditAction = {
  id: number;
  action: string;
  actor: string;
  reason: string;
  created_at: string;
};
export type DecisionDetail = {
  decision: Decision;
  event: TimelineRow;
  actions: AuditAction[] | null;
};
export type ApiResult<T> =
  | { data: T; error?: never; status?: never }
  | { data?: never; error: string; status: number };

export type DashboardAccount = {
  account_id: string;
  events_seen: number;
  active_hours: number;
  baseline_ready: boolean;
  open_reviews: number;
  suspended_keys: number;
  key_status: "active" | "suspended" | null;
  decision_id: string | null;
  event_id: string | null;
  api_key_id: string | null;
  action: Action | null;
  score: number | null;
  enforced: boolean | null;
  label: string | null;
  review_status: string | null;
  hold_status: string | null;
  occurred_at: string | null;
  ip: string | null;
  asn: number | null;
  asn_org: string | null;
  primary_driver: string;
  hits: Hit[];
};
export type DashboardSnapshot = {
  view?: "accounts" | "holds" | "keys" | "healthy";
  metrics: {
    attention_accounts: number;
    pending_quarantines: number;
    suspended_keys: number;
    healthy_baselines: number;
  };
  items: DashboardAccount[];
  total: number;
  page: number;
  limit: number;
  generated_at: string;
  engine_mode: "shadow" | "enforce";
};
export type GlobalAuditAction = AuditAction & {
  account_id: string | null;
  api_key_id: string | null;
  decision_id: string | null;
};
export type AuditPage = {
  items: GlobalAuditAction[];
  next_before_id: number | null;
};
export type DashboardInspection = {
  profile?: ProfileResponse;
  detail?: DecisionDetail;
  error?: string;
};
export type DashboardData = {
  scope: string;
  snapshot?: DashboardSnapshot;
  database_ok: boolean;
  stats?: Stats;
  audit?: AuditPage;
  inspection?: DashboardInspection;
  error?: string;
  telemetry_error?: string;
};
