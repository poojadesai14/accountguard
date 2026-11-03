import type { Period } from "./format";

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
  /** The account has a confirmed takeover: restoring needs the account ID typed. */
  takeover?: boolean;
  /** The decision that set this status: why the key was suspended. */
  cause?: { action: Action; score: number; signals: string[] } | null;
  /** Risky signals on the emails this key was stopped for: restoring needs the account ID typed. */
  warnings?: { signal: string; detail: string }[];
};
export type OpenCounts = {
  reviews: number;
  pending_holds: number;
  suspended_keys: number;
  /** Suspended keys a legitimate resolution may restore: auto-suspended by these reviews or by a decision already marked legitimate, with no takeover behind them. */
  restorable_keys: number;
  /** The open reviews; a resolution is refused if they changed since the page loaded. */
  decision_ids: string[];
  /** Risky signals on the open reviews: "legitimate" then needs the account ID typed. */
  warnings?: { signal: string; detail: string }[];
  /** What the analyst agrees to, by name. */
  list?: OpenReview[];
  suspended_key_ids?: string[];
  restorable_key_ids?: string[];
  review_key_ids?: string[];
  /** The deadline: when the first pending hold is dropped automatically. */
  holds_expire_at?: string | null;
};
/** One decision an account resolution would close. */
export type OpenReview = {
  decision_id: string;
  occurred_at: string;
  action: Action;
  score: number;
  hold_status: string | null;
  /** When a pending hold is dropped automatically if nobody decides. */
  hold_expires_at?: string | null;
  api_key_id: string | null;
  primary_driver: string;
  detail: string;
};
/** A non-allow decision marked legitimate: what a correction to takeover can act on. */
export type ReviewedDecision = {
  decision_id: string;
  occurred_at: string;
  action: Action;
  score: number;
  api_key_id: string | null;
  primary_driver: string;
};
export type Correction = {
  corrected: number;
  holds_dropped: number;
  keys_suspended: string[];
};
export type ProfileResponse = {
  profile: Profile;
  key_status: KeyStatus[] | null;
  open?: OpenCounts;
  legitimate_decisions?: ReviewedDecision[];
  /** Keys created by account changes and not deleted, newest first. */
  created_keys?: { api_key_id: string; created_at: string }[] | null;
};
export type AccountResolution = {
  outcome: "legitimate" | "takeover";
  resolved: number;
  holds_released: number;
  holds_dropped: number;
  keys_restored: string[];
  keys_suspended: string[];
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
export type Thresholds = {
  flag: number;
  hold: number;
  block: number;
  block_min_categories: number;
  single_category_exempt: string[] | null;
};
export type RelatedAccount = {
  account_id: string;
  events: number;
  worst_action: Action;
  confirmed: boolean;
  decision_id: string | null;
  last_at: string;
};
export type RelatedIndicator = {
  kind: "link_domain" | "reply_to_domain" | "ip";
  value: string;
  accounts: number;
  events: number;
  stopped: number;
  confirmed: number;
  top: RelatedAccount[];
};
export type DecisionDetail = {
  decision: Decision;
  event: TimelineRow;
  actions: AuditAction[] | null;
  thresholds?: Thresholds;
  related?: RelatedIndicator[];
  key?: KeyStatus | null;
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
  hold_expires_at: string | null;
  event_type: "email.send" | "account.change" | "api.read" | null;
  change_kind: string | null;
  key_suspended_by: "auto" | "analyst" | "owner" | null;
  key_suspended_at: string | null;
  /** This row's decision suspended its key and was marked legitimate, nothing is open, and every suspended key is in that state: restore to finish. */
  restore_pending?: boolean;
  occurred_at: string | null;
  ip: string | null;
  asn: number | null;
  asn_org: string | null;
  primary_driver: string;
  hits: Hit[];
};
export type DashboardSnapshot = {
  view?: "accounts" | "holds" | "keys" | "flagged" | "healthy";
  metrics: {
    attention_accounts: number;
    pending_quarantines: number;
    suspended_keys: number;
    flagged_accounts: number;
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
export type DashboardData = {
  scope: string;
  telemetry_period: Period;
  audit_before_id: string;
  snapshot?: DashboardSnapshot;
  stats?: Stats;
  audit?: AuditPage;
  error?: string;
  telemetry_error?: string;
};
