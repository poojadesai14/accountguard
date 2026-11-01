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

- `/`: compact global counts and a review queue showing the account, recorded
  decision and score, signal evidence, current state, and one Review action.
  Search, sorting, and pagination use the URL. The inspection drawer puts evidence
  before audited review controls; baseline details, stored metadata, and audit
  history expand on demand. Legitimate baselines and telemetry have separate tabs.
- `/accounts`: account search and review filter.
- `/accounts/[id]`: charts first, on one shared time axis: hourly recipients with
  the current baseline and spike threshold, ASN observations (first-seen in red),
  content and account-change markers, and flag/hold/block decisions (allowed
  events are counted, not drawn). A dashed line marks the first hold or block on
  every lane, which is where a takeover lights several signals up at once.
  Below: the learned baseline, key status and restoration, then the event stream
  (opens on the latest flag, hold or block) with its signal breakdown and
  copyable metadata.
- `/decisions/[id]`: the score on the engine's own 0–100 scale (flag, hold and
  block lines from `GET /v1/decisions/{id}` `thresholds`), a plain-language
  reason for the action (including the one-category cap and the two-category
  rule for block), each signal's evidence, safe event metadata, reason-required
  analyst actions, and audit history.
- `/hold/[id]`: owner response demo, behind the same analyst password gate. It
  shows the link and Reply-To domains, which are what an owner can recognize.

The visual styling follows the supplied UI specification: black and charcoal
surfaces, subtle borders, 18px page titles, 12px monospace table text, 10–11px
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
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests run a local API fixture on port 3102 and the production UI on port 3101. They exercise login/logout, session cookies, token privacy, charts, date
filters, account search, required reasons, reviews and audit history, key
restoration, owner responses, empty/error states, and mobile layout. They do not
use the hosted API or Supabase. CI runs these checks alongside the Go suite.

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
`severity=all|flag|hold|block` (the representative decision's action), `sort=priority|score_desc`, `page`, and `limit`
(default 50, capped at 200). Decision priority remains the default; Highest score
orders matching accounts by recorded score before pagination. Equal scores use
decision priority, recency, and account ID to keep pages stable. Changing the
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

Clicking a metric clears search, severity, pagination, and the inspection while
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

The UI refreshes every 30 seconds while visible, pauses for unsaved review
input and pending actions, prevents overlapping requests, and retains the last
snapshot with a stale-data message on failure. The API connection badge reflects
successful real reads. The mode badge uses the API configuration: Monitoring
only means shadow mode with automatic enforcement disabled; Enforcement active
means automatic risk decisions are enforced. Each mode has an explanatory tooltip.

Review opens Confirm takeover and Mark legitimate using the audited server actions.
No outcome is preselected: Mark legitimate teaches the baseline, so it must be
chosen deliberately. Backend 400/409 explanations (for example "hold is not
pending") are shown as-is.
Confirm takeover suspends the affected key and drops its pending holds. Both
require an actor and reason. They preserve historical scores; marking a single
event legitimate never silently restores a suspended key. No account email,
HTTP endpoint, location, or risk scores are invented.

Release the backend read endpoints before the frontend. No schema migration
or change to scoring or enforcement mode is required.
