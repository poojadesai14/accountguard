# Analyst dashboard

TypeScript, React, Next.js App Router, and Recharts. This app calls the Go analyst
API from the server. `ANALYST_TOKEN` is never sent to the browser. The UI does not
connect directly to Supabase and does not need the database password.

## Local development

Use Node.js 24, then run from `web`:

```sh
npm ci
cp -n .env.example .env.local
```

Set the values in `.env.local`:

```dotenv
API_BASE_URL=https://resend-ato-api.onrender.com
ANALYST_TOKEN=<same analyst token as the Go API>
UI_PASSWORD=<dashboard password>
```

Preserve an existing `.env.local` if one is already present. Keep it outside
version control. Start the app:

```sh
npm run dev
```

Open `http://localhost:3000` and sign in with `UI_PASSWORD`.

## Views

Three screens, one job each: the queue says what needs attention now, the
decision page explains why one email was stopped, and the account page is the
one place to decide. Every page shows the engine mode once, in the top bar
(`GET /v1/config`), and the footer keeps the "not an official Resend product"
note.

- `/`: the review queue. One slim row of counts opens each view (to review, on
  hold, keys suspended, healthy), then the decision filter, search (Enter) and
  the sort. A row opens the account page. Search, sorting, and pagination use
  the URL, so Back returns to the same filtered queue. Telemetry is a
  sidebar item (`/?tab=telemetry`).
- `/accounts` redirects to the queue search, keeping its query.
- `/accounts/[id]`: charts first, on one shared time axis: hourly recipients with
  the current baseline and spike threshold, ASN observations (first-seen in red),
  content and account-change markers, and flag/hold/block decisions (allowed
  events are counted, not drawn). A dashed line marks the first hold or block on
  every lane, which is where a takeover lights several signals up at once.
  Under the title, one line per key: every key that has sent or been suspended,
  plus keys an account change created that haven't sent yet ("Created … · no
  allowed sends yet", in orange: an attacker may create one to keep access). A
  suspended key restores inline, with the account ID typed when it was stopped
  for risky signals or after a confirmed takeover; an active key can be
  suspended. **Resolve account** closes the whole incident with one audited
  outcome (legitimate or takeover). It leads with the deadline ("Decide by …:
  the held email is dropped automatically then"), lists the reviews it closes
  and what it will and won't change, and names its button after it ("Resolve 3
  reviews as takeover"). Restoring the keys those reviews suspended is a
  separate, unticked box; otherwise the success message links to the key left
  to restore. It shows only while a review is open. **Correct to takeover**
  undoes a wrong legitimate call. Required fields are marked, and the analyst's
  name is remembered in the browser.
  Beside the charts: the baseline. Below: the event stream (opens on the latest
  flag, hold or block) beside one card for the selected event: its decision,
  signal evidence and a link to the full review, with copyable raw metadata
  collapsed underneath.
- `/decisions/[id]`: the account, the call and one status line in the header;
  then why (the score on the engine's 0–100 scale, a plain-language reason and
  each signal's evidence), the incident this email belongs to (open reviews,
  held emails, suspended keys, the deadline) with a link to decide it on the
  account page, the audit history, the same
  infrastructure on other accounts (link domains, non-freemail Reply-To domains
  and source IP within 7 days, with how many of those accounts were held,
  blocked or confirmed as takeovers), and the event metadata, collapsed.
- `/hold/[id]`: owner response demo, behind the same analyst password gate. It
  shows the link and Reply-To domains, which are what an owner can recognize.

The visual styling follows the supplied UI specification: near-black and
charcoal surfaces (not pure black, which tires the eyes over long shifts),
text greys that meet WCAG AA contrast (4.5:1) on every surface, subtle borders, 18px page titles, 12px monospace table text, 10–11px
metadata, and 24px monospace metric values. Mobile form controls retain larger
text and touch targets. Existing data fields and audited actions remain in use.
Scores are colored by the action the engine took (allow green, flag yellow,
hold orange, block red), so colors always match the configured thresholds. The
review queue filters by action (Block, Hold, Flag), not by score band.
The app is named "ATO Console" and labeled as a take-home demo; it does not use
Resend's brand, so the public login page can't be mistaken for Resend's own.

Times are UTC. The selected range filters decisions by event occurrence time.
FLAG is an observation: the email is still sent and the service does not
throttle. Charts fill empty time buckets with
zero elevated decisions instead of connecting separate incidents across gaps.
Current baseline values are shown explicitly; the API does not store historical
baselines. Shadow decisions are labeled and are not presented as enforced holds
or suspensions. Real, empty, error, and loading states are supported; the app
does not substitute demo data when the API is unavailable.

An eight-hour signed, HttpOnly cookie gates the UI. Production cookies are Secure
and SameSite=Lax. Changing `UI_PASSWORD` invalidates existing sessions. Server
actions also verify authentication and validate action parameters. Next.js
checks action origins. The owner demo is not a public signed owner link.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests run a local API fixture on port 3102 and the production UI on port 3101. They exercise login/logout, session cookies, token privacy, charts, date
filters, required reasons, account resolution and audit history, key
restoration, owner responses, empty/error states, and mobile layout. They do not
use the hosted API or Supabase. CI runs these checks alongside the Go suite.

### Full-stack scenarios

```sh
npm run build
npm run test:fullstack   # or `make e2e` from the repo root
npm run test:fullstack:watch   # same, in a visible browser, slowed down (SLOWMO=600 ms)
npm run test:fullstack:ui      # Playwright UI mode: run one scenario, step through its timeline
```

`tests/fullstack` drives the production UI (port 3201) against the **real Go API**
(port 3202) on a throwaway `ato_e2e` database in the local Docker Postgres
(`scripts/fullstack-api.sh` recreates it each run). `world.ts` builds the data
through the real ingest API, so every decision is scored by the engine: six
accounts with 12 days of history, four of them then attacked with a young link
domain until a recipient spike blocks the key; on one, the attacker also creates
a backup key. The scenarios cover the analyst's
main journeys end to end, checking both the page and the API:

| Scenario                           | Checks                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine calls reach the queue       | attacks queued with suspended keys; a lone flag and a quiet account are not                                                                              |
| A hold explains itself             | signals and evidence on the decision page; the shared domain links the other attacked accounts                                                           |
| Takeover in one step               | Resolve account → Takeover: no reviews or holds left, key suspended, row reads Confirmed takeover; the unused backup key is listed and suspended by hand |
| False positive over risky evidence | typed account ID required, restore box, key active, account in Healthy as Marked legitimate                                                              |
| Wrong call corrected               | legitimate + restore teaches the baseline; Correct to takeover relabels, unlearns the network and domain, re-suspends                                    |
| From a decision                    | the deadline shows; "Decide on the account page" → resolve; the Restore link opens the key; the account reaches Healthy                                  |
| Suspend and restore by hand        | an active key is suspended (account queued) and restored (account Healthy)                                                                               |

Young domains are pinned in `config.yaml`, so the attack scores as intended until
those dates age past `young_days`.

## Vercel deployment

Import `poojadesai14/resend-ato` into Vercel and use:

| Setting                         | Value           |
| ------------------------------- | --------------- |
| Framework preset                | Next.js         |
| Root directory                  | `web`           |
| Node.js                         | 24.x            |
| Production branch for this demo | `main`          |
| Build command                   | `npm run build` |

Set `API_BASE_URL`, `ANALYST_TOKEN`, and `UI_PASSWORD` in Vercel's server environment.
Use the analyst token already configured on Render. Do not add a `NEXT_PUBLIC_`
prefix to these variables. Do not upload `.env.local` to GitHub. This is a
server-rendered app; do not use static export.

Render's free API can sleep while idle. The UI allows time for a cold start and
displays a retry message if the connection still fails. The hosted demo runs the
API in enforce mode because all of its traffic is synthetic; a real rollout would
stay in shadow mode until the detection results and upstream enforcement
integration are ready.

## Dashboard data and actions

`GET /v1/dashboard` provides one consistent snapshot for global metrics and a
filtered page of accounts, held events, or suspended keys. It accepts
`segment=attention|baseline`, `view=accounts|holds|keys|healthy`, `q`,
`severity=all|flag|hold|block` (the representative decision's action), `sort=priority|recent`, `page`, and `limit`
(default 50, capped at 200). Most severe (`priority`, the default) orders
by action (block, hold, flag) and then score; the action already comes from the
score, so a separate score sort would give almost the same order. Newest
(`recent`) orders by event time, for following a live incident. Ties fall back to
severity, score, time, and account ID to keep pages stable. Changing the
sort resets the page while retaining the current search and severity filter.
The UI shows severity filters only in the Review queue. Switching to
Legitimate baselines clears severity; old baseline links containing a severity
parameter also show all matching baselines. Search and sorting remain available.
One account represents its highest-severity open decision, then highest score
and newest event; otherwise it represents its latest decision. Original scores
and decisions remain distinct from key suspension and analyst labels.

The four metric cards open their corresponding views. Accounts to review uses
the attention account list; Events on hold lists every pending held decision;
Suspended API keys lists each suspended key with its own decision context when
available; Healthy accounts excludes baselines still learning. Holds and keys
use the attention segment; healthy uses the baseline segment. The response
echoes `view`; totals and pagination count that view's accounts, events, or keys.
Stable key and decision IDs break ties within an account. Global metrics remain
independent of the selected view and filters.

Clicking a metric clears search, severity, and pagination while
retaining the chosen sort. The selected card is keyboard accessible and marked
as pressed; view selection persists in the URL through reloads and browser
history. Clear view returns to the tab's full account list. Zero-count cards
remain usable and show explicit empty states. This read-only interaction does
not execute a review or change any scores, baselines, or key state.

The UI verifies that the API returned the requested view and that an unfiltered
list total matches its card. Responses from an older API that ignores the view
are rejected. Cached rows are reused only for the same view, search, severity,
sort, and page, so a failed navigation cannot relabel old rows as a new bucket.
The footer shows the visible row range and total; the cards remain global and
their account, event, and key counts overlap. The full legitimate-baseline list
also includes accounts still learning, while Healthy accounts excludes them.

Healthy baselines require a legitimate latest outcome, no outstanding reviews
or suspended keys, and the configured event and active-hour minimums. Accounts
still learning their baseline are labeled explicitly. System metrics are global
current-state counts, independent of account filters and telemetry time ranges.

`GET /v1/analyst-actions` accepts RFC 3339 `from`/`to` bounds, `before_id`, and
`limit`; the end time is exclusive. Records are ordered by descending ID and
include an optional next-page cursor. Both endpoints require the analyst token.

The queue refreshes every 30 seconds while the tab is visible, never runs two
refreshes at once, and keeps the last snapshot with an error message when a
refresh fails. The mode chip comes from `GET /v1/config`: "Shadow · not
enforced" or "Enforcing".

Analysts decide per account, on the account page: Resolve account closes every
open review as Takeover or Legitimate in one audited action. No outcome is
preselected, because Legitimate teaches the baseline. Takeover keeps the keys
suspended and drops held emails; Legitimate releases held emails and restores a
key only when its box is ticked. Both require an actor and a reason, and a
reason survives a failed submit. Backend 400/409 explanations (for example "hold
is not pending") are shown as-is; on a 409 the page reloads the current reviews.
Historical scores are never rewritten.

Release the backend read endpoints before the frontend. No schema migration
or change to scoring or enforcement mode is required.
