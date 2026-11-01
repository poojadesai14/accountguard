# Resend ATO Detection - Build Spec

Companion to [README.md](README.md). The README says **why**; this file says **exactly what to build**.
If the two disagree, the README's decisions win; fix this file.

Status on 2026-10-30: spec written, nothing built.

---

## 0. Scope

In scope:
- Go service: `POST /v1/events` returns a decision synchronously; analyst JSON API; hold-expiry ticker; logs + metrics.
- Postgres (Supabase) schema.
- Next.js analyst UI (overview, account page, decision detail, owner hold view).
- Seed script, simulator, evaluation script.

Out of scope (README §7 "kept out on purpose"): Temporal, Redis/Kafka, live RDAP, redirect following,
phishing feeds, TLS fingerprinting, auto-suspension circuit breaker, actually sending held emails.

Assumptions (state in the final README):
- A1. Resend's send pipeline calls `POST /v1/events` before queuing an email and obeys the returned action.
- A2. The pipeline enriches each event with ASN data for the source IP (we don't do IP->ASN lookups).
- A3. On `hold`/`block` the pipeline still returns a normal "queued" response to the API caller.
- A4. Owner notification is out-of-band (account email / dashboard). The demo only records that it happened.

---

## 1. Repo layout

```
/cmd/server        main: HTTP server, ticker
/cmd/seed          seed script (demo scenarios)
/cmd/sim           simulator: labeled scenarios -> events -> server
/cmd/eval          evaluation: reads decisions + labels, prints precision/recall
/internal/config   config.yaml loading + validation
/internal/event    event types, validation, feature extraction
/internal/signal   the four signals (one file each)
/internal/engine   runs signals, scores, picks the action
/internal/store    Postgres access, transactions, migrations
/internal/api      HTTP handlers, auth middleware
/internal/metrics  Prometheus collectors
/migrations        SQL files, applied in order
/web               Next.js app
config.yaml
```

Go 1.22+, `net/http` with the 1.22 router, `pgx/v5`, `log/slog`, `prometheus/client_golang`,
`golang.org/x/net/publicsuffix`, `gopkg.in/yaml.v3`. No web framework.

Environment variables (never committed): `DATABASE_URL`, `INGEST_TOKEN`, `ANALYST_TOKEN`, `CONFIG_PATH`
(default `config.yaml`), `PORT` (default 8080).

---

## 2. Events

One JSON object per request to `POST /v1/events`. Three types share an envelope.

### 2.1 Envelope (all types)

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_id` | string | yes | Idempotency key. Unique across all events. |
| `type` | string | yes | `email.send` \| `account.change` \| `api.read` |
| `occurred_at` | RFC 3339 | yes | All time windows use this, not wall clock (the seed backfills months). |
| `account_id` | string | yes | |
| `api_key_id` | string | yes for `api`/`smtp` source | Key id, never the key secret. |
| `source` | string | yes | `api` \| `smtp` \| `dashboard` |
| `network.ip` | string | yes | |
| `network.asn` | int | yes | Enriched by the pipeline (A2). |
| `network.asn_org` | string | no | For display only. |
| `client.user_agent` | string | no | Stored, not scored (README §4). |

Unknown fields are ignored. Missing required fields -> `400`.

### 2.2 `email.send`

One event per email. A batch request produces one event per item.

```json
{
  "event_id": "evt_01JBX3K9",
  "type": "email.send",
  "occurred_at": "2026-10-30T14:02:11Z",
  "account_id": "acc_acme",
  "api_key_id": "key_prod_1",
  "source": "api",
  "network": { "ip": "203.0.113.9", "asn": 14061, "asn_org": "DIGITALOCEAN-ASN" },
  "client": { "user_agent": "resend-node:4.0.0" },
  "email": {
    "from": "Acme Billing <billing@acme.com>",
    "to": ["a@example.org"],
    "cc": [],
    "bcc": [],
    "reply_to": ["support@acme.com"],
    "headers": { "X-Entity-Ref-ID": "123" },
    "html": "<p>Pay here: <a href=\"https://invoice-portal.net/pay\">link</a></p>",
    "text": null
  }
}
```

### 2.3 `account.change`

```json
{
  "event_id": "evt_01JBX2AA",
  "type": "account.change",
  "occurred_at": "2026-10-30T13:55:00Z",
  "account_id": "acc_acme",
  "api_key_id": "key_prod_1",
  "source": "api",
  "network": { "ip": "203.0.113.9", "asn": 14061 },
  "change": { "kind": "api_key.created", "target_id": "key_new_7" }
}
```

`change.kind`: `api_key.created`, `api_key.deleted`, `team_member.added`, `webhook.created`,
`webhook.updated`, `webhook.deleted`, `domain.updated`.
For `source: dashboard`, `api_key_id` may be empty; network scoring is then skipped (no key to compare).

### 2.4 `api.read`

```json
{
  "event_id": "evt_01JBX1ZZ",
  "type": "api.read",
  "occurred_at": "2026-10-30T13:50:00Z",
  "account_id": "acc_acme",
  "api_key_id": "key_prod_1",
  "source": "api",
  "network": { "ip": "203.0.113.9", "asn": 14061 },
  "read": { "resource": "contacts", "status": 403 }
}
```

`read.resource`: `contacts`, `audiences`, `domains`, `emails`, `api_keys`, `webhooks`.
A `403` counts as a read attempt (recon with a sending-only key is still recon).

### 2.5 Feature extraction (privacy rule)

Done in memory on arrival. **Bodies, subjects and full recipient addresses are never stored or logged.**

| Feature | How |
|---|---|
| `sender_domain` | Registrable domain (eTLD+1) of the `from` address. |
| `recipient_count` | `len(to) + len(cc) + len(bcc)`. |
| `link_domains` | Registrable domains of every `href`/`src` URL in `html`, and every `http(s)://` URL in `text` and `html` text nodes. |
| `reply_to_domains` | Registrable domains from `reply_to[]` and any header named `Reply-To` (case-insensitive), merged. |
| `body_email_domains` | Registrable domains of email addresses found by regex in `text`/`html` (not in headers). |

All domains are lowercased and reduced with `publicsuffix.EffectiveTLDPlusOne`; failures are dropped.
`app.acme.com` and `acme.com` are the same domain. The sender's own domain is excluded from
`link_domains`, `reply_to_domains` and `body_email_domains` before scoring.

---

## 3. Signals

Each signal is a value of:

```go
type EvalFunc func(in *Input) []Hit

type Signal struct {
    Name     string   // e.g. "network"
    Category string   // network | velocity | content | account
    Eval     EvalFunc
}
type Hit struct {
    Name, Category string
    Points         int
    Detail         string // human-readable, shown in the UI
}
```

Signals run sequentially (README §7). Adding a signal = appending to the slice; the engine doesn't change.
`EvalContext` holds the event, extracted features, the locked profile, the velocity window count,
and the config.

**Cold start:** `profile.events_seen < baseline.min_events` (default 50) -> every signal marked
*history* below returns no hits.

### 3.1 Network (category `network`, history)

| Hit | Condition | Points |
|---|---|---|
| `new_asn` | `network.asn` not in this key's ASN set | 30 |

- The key's ASN set = `profile.key_asns[api_key_id]`.
- If that key has fewer than `network.min_key_events` (default 20) allowed events, compare against the union
  of all the account's ASNs instead (a new key on an old account isn't automatically "new network").
- Skipped when `api_key_id` is empty.
- Detail: `AS14061 DIGITALOCEAN-ASN first seen for key key_prod_1`.

### 3.2 Velocity (category `velocity`, history)

| Hit | Condition | Points |
|---|---|---|
| `recipient_spike` | `window_recipients > velocity.multiplier * max(hourly_baseline, velocity.min_hourly_baseline)` | 15 |

- `window_recipients` = sum of `recipient_count` over this account's `email.send` events with
  `occurred_at` in `(t - 1h, t]`, **including the current event and including non-allowed events**
  (the attacker's own sends count toward the spike).
- `hourly_baseline` = `profile.hourly_ewma`: an EWMA of recipients per **active** hour (hours with zero
  sends are skipped), built from allowed events only. See §5.3.
- Also requires `profile.active_hours >= velocity.min_active_hours` (default 24).
- Defaults: `multiplier: 3`, `min_hourly_baseline: 10`.
- Only applies to `email.send`.

### 3.3 Content (category `content`)

Applies to `email.send`. Candidate domains = `link_domains ∪ reply_to_domains ∪ body_email_domains`.
Each hit fires **at most once per event**, however many domains trigger it. Detail lists the domains.

| Hit | Condition | Points | History? |
|---|---|---|---|
| `new_domain` | any candidate not in `profile.known_domains` | 25 | yes |
| `young_domain` | any candidate whose registration date in `content.domain_ages` is < 30 days before `occurred_at` | 20 | no |
| `lookalike_domain` | any candidate that is a lookalike of `sender_domain` or of any domain in `profile.sender_domains` | 30 | no |
| `freemail_reply_to` | any `reply_to_domains` entry is in `content.freemail_domains` **and** the account has never used a free-mail Reply-To | 15 | yes |

Lookalike, exactly: compare the registrable label without the public suffix (`acme` from `acme.com`).
Candidate domain `cd` with label `c`, brand domain `bd` with label `b`. Requires `cd != bd` and
`len(b) >= content.lookalike_min_len` (default 4). Lookalike if any of:
- **typo:** `c != b` and `levenshtein(c, b) <= 2` (`acrne.com`)
- **other suffix:** `c == b`, suffix differs (`acme.co` vs `acme.com`)
- **contains brand:** `c != b` and `c` contains `b` (`acme-secure.com`, `myacme.net`, `acmebilling.com`)

The brand's own other domains (`acmecdn.com`) also match "contains brand". On an established account they're
already in `known_domains`, so they get no `new_domain` points and score 30 alone -> `flag` at most.
To stop that, any candidate already in `known_domains` is **not** checked for lookalike.

Sender domains are only `From` domains, which Resend requires to be verified. Link, Reply-To and body domains
are never verified, which is why the lookalike check runs on them. If the attacker adds and verifies their own
lookalike sending domain, that shows up as `account.change` `domain.updated` (§3.4), and the new `From`
domain is checked against `profile.sender_domains`. (Verify against Resend's docs that a full-access key can
add domains through the API.)

Domain age: `content.domain_ages` in config stands in for RDAP. Domains not listed are treated as **not young**.

### 3.4 Account changes (category `account`, no history)

| Hit | Condition | Points |
|---|---|---|
| `recent_account_change` | any `account.change` on this account in `(t - 24h, t]`, including the current event | 20 |
| `first_read` | any first-ever read of `contacts`, `audiences` or `domains` on this account in `(t - 24h, t]`, including the current event | 20 |

- Uses `profile.last_change_at` and `profile.last_first_read_at` (§5.3).
- `first_read` is quiet while the account is younger than `account.first_read_min_account_age` (default 7d),
  measured as `occurred_at - profile.first_seen_at`. During onboarding every read is a first read.
  (`first_seen_at` stands in for the account creation date.)
- Applies to all event types, so a send 10 minutes after a new key is created gets +20.
- Each hit fires once per event.

---

## 4. Scoring and action

```
score    = min(100, sum(hit.Points))
cats     = distinct categories among hits

if key_status[api_key_id] == suspended:      action = block,  reason = "key_suspended"
else if score >= thresholds.block and len(cats) >= 2:  action = block
else if score >= thresholds.hold:            action = hold
else if score >= thresholds.flag:            action = flag
else:                                        action = allow

// one category alone can at most flag, except content (README §5 exception)
if len(cats) == 1 and cats[0] != "content" and action > flag:  action = flag
```

Defaults: `flag: 30`, `hold: 60`, `block: 80`. Content alone can reach `hold`, never `block`.

Side effects of the action:
- `hold`: decision gets `hold_status = pending`, `hold_expires_at = now() + hold.ttl`. The owner is
  notified out-of-band (A4); the demo doesn't send or record a notification.
- `block`: upsert `key_status` to `suspended` (`reason = auto`). The account and other keys are untouched.
- Events with an empty `api_key_id` are never `block`ed (no key to suspend); they cap at `hold`.

**Shadow mode** (`mode: shadow`): compute and store everything, set `enforced = false`, and always respond
`allow`. No key suspension, no holds. `mode: enforce` is normal.

### 4.1 Expected results (these become table-driven tests)

| Scenario | Hits | Score | Action |
|---|---|---|---|
| Normal send | - | 0 | allow |
| Legit campaign | recipient_spike | 15 | allow |
| Infra migration | new_asn | 30 | flag |
| New key created then used from same network | recent_account_change | 20 | allow |
| Recon: first contacts read + new key in 24h | first_read, recent_account_change | 40 | flag |
| Takeover: new network + new young link domain | new_asn, new_domain, young_domain | 75 | hold |
| Same, with spike | + recipient_spike | 90 | block |
| Takeover: new network + new young link containing the brand (`acme-secure.com`) | new_asn, new_domain, young_domain, lookalike_domain | 100 | block |
| Brand's own known domain `acmecdn.com` | - (known domains skip lookalike) | 0 | allow |
| New account (3 days old) reads contacts | - (first_read quiet) | 0 | allow |
| Clean-history account, young lookalike link | young_domain, lookalike_domain | 50 | flag |
| Content only: new + young + lookalike | 3 content hits | 75 | hold |
| Network + account change only, score 90 artificially | 2 categories | >=80 | block |
| Any event from a suspended key | - | - | block (`key_suspended`) |
| Cold start (10 events), new ASN + spike | none (history signals quiet) | 0 | allow |

---

## 5. Storage

### 5.1 Schema (`migrations/001_init.sql`)

```sql
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
  user_agent         text,
  -- email.send features only
  sender_domain      text,
  recipient_count    int not null default 0,
  link_domains       text[] not null default '{}',
  reply_to_domains   text[] not null default '{}',
  body_email_domains text[] not null default '{}',
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
  config_version    text not null,
  latency_us        int,
  hold_status       text check (hold_status in ('pending','released','dropped','expired')),
  hold_expires_at   timestamptz,
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
```

`review_status` is `open` for `hold`/`block` decisions and `none` for `allow`/`flag` (flags are logged and charted, not queued) and for `key_suspended` rejections (the suspension and its triggering decision are the case; a rejected send is not a review of its own). An account counts as legitimate when its latest *scored* decision (ignoring `key_suspended` rejections) is `allow` or labelled `legitimate`.
Any analyst or owner action on a decision sets it to `resolved`.

### 5.2 Request transaction (`POST /v1/events`)

```
begin
  insert into events ... on conflict (event_id) do nothing
  if no row inserted: rollback; return the existing decision (200, same body)
  insert profile if missing (first_seen_at = occurred_at)
  select * from profiles where account_id = $1 for update
  select status from key_status where api_key_id = $2
  window_recipients = sum(recipient_count) from events
                      where account_id = $1 and type = 'email.send'
                        and occurred_at > $t - interval '1 hour' and occurred_at <= $t
  hits = run signals (compare FIRST)
  action = decide(hits)
  insert into decisions ...
  apply side effects (hold fields, key_status)
  update profile (§5.3)                 -- update AFTER compare
commit
respond
```

### 5.3 Profile update rules

Always (every decision, so the attacker can't hide changes by getting held):
- `account.change` -> `last_change_at = occurred_at`.
- `api.read` of a resource not in `read_resources` -> append it; if it's `contacts`, `audiences` or `domains`,
  set `last_first_read_at = occurred_at`.

Only when the final action is `allow` (or later, on `mark_legitimate` / `owner_this_was_me`):
- `events_seen += 1`; `key_asns[key][asn] += 1` (a key's event count is the sum over its ASNs).
- `email.send`: add candidate domains to `known_domains` (cap `baseline.max_known_domains`, default 5000,
  evict lowest count); add `sender_domain` to `sender_domains`; set `used_freemail_reply_to` if applicable.
- `email.send` velocity bucket, with `h = date_trunc('hour', occurred_at)`:
  - if `hour_bucket_start` is null: start bucket `h` with this event's recipients.
  - if `h == hour_bucket_start`: `hour_bucket_recipients += recipient_count`.
  - if `h > hour_bucket_start`: fold the old bucket in
    (`hourly_ewma = alpha * old + (1 - alpha) * hourly_ewma`, or `= old` when `active_hours == 0`),
    `active_hours += 1`, start bucket `h`.
  - `alpha` = `velocity.ewma_alpha` (default 0.1).

`mark_legitimate` replays these allowed-only updates using the stored event row.

### 5.4 Fail-open

If anything between `begin` and `commit` fails (DB down, timeout of `scoring.timeout_ms`, panic):
- Respond `200` with `action: allow, unscored: true, score: 0, hits: []`.
- Log at `ERROR` with `event_id`, increment `ato_unscored_total`.
- Best effort: write the raw envelope (no body) to `events` with no decision, so a later
  `cmd/rescore` can score it. (Rescore tool is nice-to-have.)

---

## 6. HTTP API

All JSON. Errors: `{"error": "message"}` with `400`, `401`, `404`, `409`, `500`.

### 6.1 Ingest (auth: `Authorization: Bearer $INGEST_TOKEN`)

`POST /v1/events` -> `200`

```json
{
  "event_id": "evt_01JBX3K9",
  "decision_id": "6f0c...",
  "action": "hold",
  "enforced": true,
  "score": 75,
  "hits": [
    { "name": "new_asn", "category": "network", "points": 30,
      "detail": "AS14061 DIGITALOCEAN-ASN first seen for key key_prod_1" },
    { "name": "new_domain", "category": "content", "points": 25,
      "detail": "link domain invoice-portal.net never used by this account" },
    { "name": "young_domain", "category": "content", "points": 20,
      "detail": "invoice-portal.net registered 2026-10-26 (4 days)" }
  ],
  "reason": null,
  "unscored": false,
  "config_version": "2026-10-30.1",
  "latency_us": 2140
}
```

Duplicate `event_id` -> same body, `200`. Body limit 1 MB.

### 6.2 Analyst API (auth: `Authorization: Bearer $ANALYST_TOKEN`)

| Method + path | Returns |
|---|---|
| `GET /v1/config` | `mode` (shadow/enforce), `config_version`, `thresholds`, so every UI page can state the mode once |
| `POST /v1/accounts/{id}/resolve` | body `{decision_ids, outcome: legitimate\|takeover, restore_keys, actor, reason}`. `decision_ids` are the open reviews the analyst saw. Closes every open review on the account in one transaction (labels, baseline learning, holds released or dropped, keys suspended on takeover), one audit row per change. With `restore_keys` (legitimate only), restores just the keys auto-suspended by those reviews with no takeover label behind them. Returns `{outcome, resolved, holds_released, holds_dropped, keys_restored, keys_suspended}`; 409 when nothing is open or the open reviews differ from `decision_ids` |
| `GET /v1/stats?from&to&bucket=1h\|1d` | `totals` {events, allow, flag, hold, block} (unscored events have no decision row; count them from the `ato_unscored_total` metric); `series` [{t, flag, hold, block}]; `top_signals` [{name, count}]; `review_queue` [{account_id, open_count, max_action, last_at}] |
| `GET /v1/accounts?q&needs_review=true` | account list: id, events, last action, open reviews |
| `GET /v1/accounts/{id}/timeline?from&to` | events joined with decisions, ordered by `occurred_at`; each row has event metadata (no bodies), action, score, hits |
| `GET /v1/accounts/{id}/series?from&to` | `baseline_hourly` and `spike_threshold` (current values; baseline history isn't stored), plus `points` per hour: `recipients`, `asns` [{asn, org, first_seen}], `content_hits` [names], `account_changes`, `actions` {action: count} |
| `GET /v1/accounts/{id}/profile` | current profile, `key_status` for its keys, and `open` {reviews, pending_holds, suspended_keys, restorable_keys, decision_ids}: what a resolution would close |
| `GET /v1/decisions/{id}` | decision + event + analyst_actions for it + thresholds + `related`: other accounts sharing its link domains, non-freemail Reply-To domains or IP within ±7 days ({kind, value, accounts, events, stopped, confirmed, top[≤50]}; the UI shows five and expands to the rest) |
| `POST /v1/decisions/{id}/actions` | body `{"action": "confirm_takeover\|mark_legitimate\|release_hold", "actor": "pooja", "reason": "..."}` |
| `POST /v1/keys/{key_id}/unblock` | body `{"actor", "reason"}` |

`reason` is required on every action (`400` without it). Effects:

| Action | Effect |
|---|---|
| `confirm_takeover` | suspend the decision's key (`reason = analyst`); every `pending` hold for that key -> `dropped`; `label = takeover` |
| `mark_legitimate` | if hold `pending` -> `released`; replay allowed-only profile updates for the event; `label = legitimate` |
| `release_hold` | `pending` -> `released`; no profile change; no label |
| `unblock_key` | `key_status` -> `active` |

Acting on a hold that's not `pending` -> `409`.

### 6.3 Owner hold response (auth: signed link token; for the demo, `ANALYST_TOKEN` is fine)

`POST /v1/holds/{decision_id}/owner-response` body `{"response": "this_was_me" | "not_me"}`
- `this_was_me` -> same as `mark_legitimate` with `actor = owner`.
- `not_me` -> same as `confirm_takeover` with `actor = owner`.

### 6.4 Ops (no auth)

- `GET /healthz` -> `200 ok` if the DB ping succeeds, else `503`.
- `GET /metrics` -> Prometheus.

---

## 7. Background work

- **Hold expiry ticker**, every `hold.tick` (default 1m): `update decisions set hold_status = 'expired'
  where hold_status = 'pending' and hold_expires_at < now()`. Expired holds stay `review_status = open`.
  `hold.expire_action` decides what the pipeline would do: `drop` (default) or `release`.
  Uses wall clock, unlike signal windows.
  - **drop:** the held email is never delivered. Shown to the owner as failed ("held for security review,
    not confirmed") in the dashboard only, never through the API, so the attacker gets no feedback.
    The owner can resend.
  - **release:** the email is delivered late, as if it had never been held.
  - Default `drop`: if it was a takeover, releasing delivers the phishing anyway. A legitimate owner was
    notified and loses one email at worst.
- Graceful shutdown: stop ticker, drain HTTP (10 s), close pool.

---

## 8. Config (`config.yaml`)

```yaml
version: "2026-10-30.1"     # stored on every decision; bump on any change
mode: enforce               # enforce | shadow

scoring:
  timeout_ms: 200
  max_score: 100

thresholds:
  flag: 30
  hold: 60
  block: 80
  block_min_categories: 2
  single_category_cap: flag     # cap when only one category fired...
  single_category_exempt: [content]   # ...except these

baseline:
  min_events: 50
  max_known_domains: 5000

network:
  min_key_events: 20
  points:
    new_asn: 30

velocity:
  window: 1h
  multiplier: 3
  min_hourly_baseline: 10
  min_active_hours: 24
  ewma_alpha: 0.1
  points:
    recipient_spike: 15

content:
  young_days: 30
  lookalike_max_distance: 2
  lookalike_min_len: 4
  points:
    new_domain: 25
    young_domain: 20
    lookalike_domain: 30
    freemail_reply_to: 15
  freemail_domains: [gmail.com, googlemail.com, outlook.com, hotmail.com, live.com,
                     yahoo.com, icloud.com, proton.me, protonmail.com, aol.com, gmx.com, mail.com]
  domain_ages:              # stands in for RDAP; unlisted = not young
    invoice-portal.net: 2026-10-26
    acrne.com: 2026-10-20
    betta.io: 2026-10-22

account:
  window: 24h
  recon_resources: [contacts, audiences, domains]
  points:
    recent_account_change: 20
    first_read: 20
  first_read_min_account_age: 168h   # 7 days

hold:
  ttl: 24h
  tick: 1m
  expire_action: drop
```

Validation on startup (fail to boot if wrong): thresholds ascending, all points >= 0, `mode` valid,
every signal named in `points` exists.

---

## 9. Observability

One `slog` JSON line per decision, `INFO`:
```
{"msg":"decision","event_id":"...","account_id":"...","api_key_id":"...","type":"email.send",
 "action":"hold","enforced":true,"score":75,"hits":["new_asn","new_domain","young_domain"],
 "config_version":"...","latency_us":2140}
```
Never log bodies, subjects, recipient addresses, or tokens.

Metrics:
- `ato_decisions_total{action, enforced}` counter
- `ato_signal_hits_total{name}` counter
- `ato_scoring_latency_seconds` histogram
- `ato_unscored_total` counter
- `ato_holds_pending` gauge (updated by the ticker)

---

## 10. Frontend (`/web`, Next.js App Router + Recharts, Vercel)

- Password gate: Next.js middleware checks a cookie set by `/login` against `UI_PASSWORD`.
  Server components call the Go API with `ANALYST_TOKEN`; the token never reaches the browser.
- Env: `API_BASE_URL`, `ANALYST_TOKEN`, `UI_PASSWORD`.

| Route | Content |
|---|---|
| `/` | Totals tiles (allow as a number only), stacked flag/hold/block chart, top signals, review queue |
| `/accounts` | Searchable list |
| `/accounts/[id]` | Stacked charts on one shared time axis: recipients/hour with baseline band; ASN dots (first-seen red); content markers; account-change markers; decision strip. Below: timeline table. |
| `/decisions/[id]` | Score, action, each hit with points and detail, event metadata, action buttons with required reason, action history |
| `/hold/[id]` | Owner view: what was held (metadata only), "This was me" / "Not me" |

---

## 11. Seed, simulator, evaluation

### 11.1 `cmd/seed` (demo, deterministic)

Account `acc_acme`, key `key_prod_1`, sender `acme.com`, ASN 16509 (AWS):
1. 60 days of normal sends: 20-60 recipients/hour in business hours, link domains `acme.com`,
   `stripe.com`, `twitter.com`. -> all `allow`.
2. One campaign hour at 10x -> `allow` (15).
3. Clean-history account `acc_beta` (5 events), sender `beta.io`, sends a link to `betta.io`
   (listed as young) -> `flag` 50 (young_domain + lookalike_domain).
4. Takeover on `acc_acme`, from ASN 14061 (DigitalOcean), no recon or account changes:
   - first send, link `invoice-portal.net` -> `hold` 75 (new_asn + new_domain + young_domain)
   - 40 more sends in the same hour, 5 recipients each (window > 3x baseline) -> `block` 90, key suspended
   - next send -> `block`, `reason: key_suspended`
5. Seed exits non-zero if any decision differs from the expected list.

This gives the README's arc: flag 50 -> hold 75 -> block 90 -> key_suspended. Recon is kept out of the
`acc_acme` arc on purpose: `first_read` stays active for 24h and would add 20 to every later event
(the first send would score 95 and block straight away). The sim covers recon separately.

### 11.2 `cmd/sim` (simulator + evaluation in one)

`make sim` generates N accounts (default 200), posts their events to a running server in time order, and
prints the report. Labels stay in memory, so no `sim_labels` table is needed.

- Kinds: **historical** (30-45 days of normal sending) and **clean** (2-4 days, cold start). Default 30% clean.
- Each account gets one scenario on day 0. Default 40% takeovers (far above real life, to get enough examples).
  - legit: normal, campaign, cloud migration, new helpdesk Reply-To, new partner link, new API key,
    new member then campaign, owner uses gmail Reply-To
  - takeover: fast, slow, same cloud, compromised server (aged domain), BEC gmail Reply-To (new network and
    same cloud), recon then send, brand lookalike, known-domain abuse (expected miss)
- Young domains come from `content.domain_ages` in the config, so they must be young relative to today.

Report: precision and recall per action threshold (historical / clean / all); per takeover scenario the share
flagged and stopped and attacker emails delivered; per legit scenario the share flagged, held, blocked;
false positives per 1,000 legitimate accounts; per-signal precision; owner emails blocked because their key
was suspended (the cost of key suspension); scoring latency.

## 12. Tests

- `internal/engine`: table-driven, one row per line of §4.1.
- `internal/event`: extraction (subdomains collapse, Reply-To header merge, sender domain excluded, bad URLs dropped).
- `internal/signal`: lookalike pairs (`acme`/`acrne` yes, `acme-secure`/`acme` yes, `acme.co`/`acme.com` yes,
  `acme.com`/`acme.com` no, `ab`/`ac` no - too short, known `acmecdn.com` no), `first_read` quiet under 7 days,
  cold start silences history signals.
- `internal/store` (integration, needs `TEST_DATABASE_URL`): idempotency, compare-then-update,
  non-allowed events don't change baseline, `last_change_at` updates even on hold, concurrent events
  on one account don't lose updates.

---

## 13. Open questions / decisions to confirm

1. Seed arc vs `first_read` 24h window (§11.1). Chosen: keep recon out of the demo arc. Alternative:
   shorten the recon window to 1h.

Decided on 2026-10-30 (carry these into the README):
- `first_read` is quiet for accounts younger than 7 days (§3.4).
- Lookalike also matches domains containing the brand label, skipping domains the account already uses (§3.3).
  The demo link changed from `acme-billing.co` to `invoice-portal.net` so the first takeover send still holds at 75.
- Expired holds are dropped, not released (§7).
- Add to the README's verify list: can a full-access API key add and verify a sending domain?
