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

- `/`: action totals, stacked flag/hold/block chart, top signals, and review queue.
- `/accounts`: account search and review filter.
- `/accounts/[id]`: volume with current baseline and spike threshold, ASN
  observations, content/account markers, decisions on a shared time axis,
  timeline, profile, key status, and key restoration.
- `/decisions/[id]`: scores, each signal's evidence, safe event metadata,
  reason-required analyst actions, and audit history.
- `/hold/[id]`: owner response demo, behind the same analyst password gate.

Times are UTC. The selected range filters decisions by event occurrence time.
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

| Setting                         | Value               |
| ------------------------------- | ------------------- |
| Framework preset                | Next.js             |
| Root directory                  | `web`               |
| Node.js                         | 24.x                |
| Production branch for this demo | `render-deployment` |
| Build command                   | `npm run build`     |

Set `API_BASE_URL`, `ANALYST_TOKEN`, and `UI_PASSWORD` in Vercel's server environment.
Use the analyst token already configured on Render. Do not add a `NEXT_PUBLIC_`
prefix to these variables. Do not upload `.env.local` to GitHub. This is a
server-rendered app; do not use static export.

Render's free API can sleep while idle. The UI allows time for a cold start and
displays a retry message if the connection still fails. Keep the API in shadow
mode until the detection results and upstream enforcement integration are ready.
