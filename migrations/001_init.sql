-- Schema from SPEC.md §5.1. No email bodies, subjects or recipient addresses are stored.

create table events (
  event_id           text primary key,
  type               text not null check (type in ('email.send','account.change','api.read')),
  occurred_at        timestamptz not null,
  received_at        timestamptz not null default now(),
  account_id         text not null,
  api_key_id         text,
  source             text not null check (source in ('api','smtp','dashboard')),
  ip                 inet,
  asn                int,
  asn_org            text,
  country            text,
  user_agent         text,
  -- email.send features only
  batch_id           text,
  sender_domain      text,
  recipient_count    int not null default 0,
  recipient_domains  text[] not null default '{}',
  link_domains       text[] not null default '{}',
  reply_to_domains   text[] not null default '{}',
  body_email_domains text[] not null default '{}',
  attachment_exts    text[] not null default '{}',
  -- account.change / api.read
  change_kind        text,
  change_target_id   text,
  read_resource      text,
  read_status        int
);
create index events_account_time on events (account_id, occurred_at);

create table profiles (
  account_id             text primary key,
  first_seen_at          timestamptz not null,
  events_seen            int not null default 0,      -- allowed events folded into the baseline
  key_asns               jsonb not null default '{}', -- {"key_prod_1": {"16509": 912}}
  key_events             jsonb not null default '{}', -- {"key_prod_1": 912}
  known_domains          jsonb not null default '{}', -- {"stripe.com": 40}
  sender_domains         text[] not null default '{}',
  used_freemail_reply_to boolean not null default false,
  hourly_ewma            double precision not null default 0,
  active_hours           int not null default 0,
  hour_bucket_start      timestamptz,
  hour_bucket_recipients int not null default 0,
  read_resources         text[] not null default '{}', -- resources ever read
  last_change_at         timestamptz,                  -- any account.change, any decision
  last_first_read_at     timestamptz,                  -- any first-ever read, any decision
  updated_at             timestamptz not null default now()
);

create table decisions (
  decision_id       uuid primary key default gen_random_uuid(),
  event_id          text not null unique references events(event_id),
  account_id        text not null,
  api_key_id        text,
  occurred_at       timestamptz not null,
  decided_at        timestamptz not null default now(),
  action            text not null check (action in ('allow','flag','hold','block')),
  enforced          boolean not null,
  score             int not null,
  hits              jsonb not null,  -- [{"name","category","points","detail"}]
  reason            text,            -- e.g. key_suspended
  unscored          boolean not null default false,
  config_version    text not null,
  latency_us        int,
  hold_status       text check (hold_status in ('pending','released','dropped','expired')),
  hold_expires_at   timestamptz,
  owner_notified_at timestamptz,
  review_status     text not null default 'none' check (review_status in ('none','open','resolved')),
  label             text check (label in ('takeover','legitimate'))
);
create index decisions_account_time on decisions (account_id, occurred_at);
create index decisions_review on decisions (review_status) where review_status = 'open';
create index decisions_hold_pending on decisions (hold_expires_at) where hold_status = 'pending';

create table key_status (
  api_key_id  text primary key,
  account_id  text not null,
  status      text not null check (status in ('active','suspended')),
  reason      text not null check (reason in ('auto','analyst','owner')),
  decision_id uuid references decisions(decision_id),
  updated_at  timestamptz not null default now()
);

create table analyst_actions (
  id          bigserial primary key,
  decision_id uuid references decisions(decision_id),
  api_key_id  text,
  action      text not null check (action in
                ('confirm_takeover','mark_legitimate','release_hold','unblock_key',
                 'owner_this_was_me','owner_not_me')),
  actor       text not null,
  reason      text not null,
  created_at  timestamptz not null default now()
);
