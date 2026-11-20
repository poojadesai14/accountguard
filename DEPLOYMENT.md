# Backend testing and deployment

The intended stack is a Go API on Render, Supabase Postgres, and the Next.js
analyst UI on Vercel. This repository contains the Go backend, migrations, seed,
simulator, and the Next.js analyst dashboard in `/web`. The API exposes
Prometheus metrics at `GET /metrics` (`make prom-up` runs a local Prometheus UI).
Dashboard setup and Vercel settings are in [web/README.md](web/README.md).

## Run the complete backend tests

```sh
make test
```

This starts the local PostgreSQL service, creates the separate `ato_test`
database if needed, and runs all tests with race detection. It does not reset the
demo database. API integration tests use a fresh schema per fixture and remove
their schemas afterward. Engine integration tests use unique account IDs.
Functional database test fixtures use a five-second scoring deadline to tolerate
race instrumentation and shared CI scheduling. The dedicated timeout test uses
an explicit short deadline to verify fail-open and rollback behavior. The deployed
scoring deadline remains 200 ms.

To use an existing test PostgreSQL server:

```sh
TEST_DATABASE_URL='postgres://ato:ato@localhost:5432/ato_test?sslmode=disable' \
  go test -race -count=1 ./...
```

Use a disposable test database with schema-creation privileges. Running plain
`go test ./...` without `TEST_DATABASE_URL` skips database integration tests.

The HTTP suite covers every analyst route: authentication and token separation,
input validation, stats and time ranges, account search, timelines, chart series,
profiles and key status, decision details, release/confirm/unblock actions,
legitimate-event learning, owner responses, expired holds, concurrent reviews,
audit records, metadata privacy, shadow mode, duplicate events, and database
failure behavior. The workflow in `.github/workflows/backend-tests.yml` runs
against PostgreSQL 16 and builds the deployment image on pushes and pull
requests. It checks formatting, runs `go vet`, executes the full test suite with
race detection, and builds the Docker image before the commit can auto-deploy.

### Local verification on 2026-10-30

- All backend tests passed with PostgreSQL and race detection; `go vet ./...`
  and formatting checks passed.
- Combined internal-package statement coverage: 90.3%; HTTP API package: 96.9%.
- The non-root deployment image built successfully; its migration command and
  `/healthz` check passed against the test database.
- The deterministic seed passed all 597 event assertions through the container.
- The simulator completed 55,164 events across 200 accounts at approximately
  3,106 events/second, with reported scoring latency p50 0.7 ms and p95 1.8 ms.
- In that synthetic sample, hold-or-block precision was 100% and recall was 55%.
  There were no legitimate holds or blocks, but 265 flagged legitimate accounts
  per 1,000. Cold-start attacks had no holds or blocks; known-domain abuse and
  compromised-server scenarios were missed. Key suspension also blocked 141
  later owner emails across 23 accounts.

These results apply to synthetic scenarios and local PostgreSQL. Hosted database
latency and detection quality on real traffic still need staging validation.

## Build and run the API image

```sh
docker build -t accountguard:local .
```

The image contains the server, migration binary, configuration, TLS root
certificates, and an Alpine runtime for platform command execution. It runs as a
non-root user. Local `.env` files are excluded from
the build. See the [Docker multi-stage build documentation](https://docs.docker.com/build/building/multi-stage/).

Create a deployment environment file outside version control containing:

```dotenv
DATABASE_URL=<Supabase PostgreSQL connection URI with TLS enabled>
INGEST_TOKEN=<ingest secret>
ANALYST_TOKEN=<different analyst secret>
PORT=8080
```

Run migrations as a single release step before starting the API:

```sh
docker run --rm --env-file .env.deploy --entrypoint /app/migrate accountguard:local
docker run --rm --env-file .env.deploy -p 8080:8080 accountguard:local
```

On a hosting platform, use its secret store instead of an environment file. Set
the readiness check to `GET /healthz` and allow the server's 10-second graceful
shutdown. Run the API as a persistent process so the hold-expiry ticker runs.
Run one migration job per release; the migration runner does not coordinate
concurrent migration processes.

## Connect Supabase

Copy the connection URI from the project's Connect dialog. For a persistent Go
backend, use a direct connection when the host supports the endpoint's network
address family, or the shared pooler in session mode for an IPv4-only host. This
retains compatibility with pgx's prepared statements. Use the direct connection
for migration jobs. Supabase documents these choices in
[Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres).

Create a private schema first, for example `create schema ato;`, and keep it
excluded from the Supabase Data API. Include `search_path=ato` in both the
migration and server connection URIs before applying the migrations. See
[Supabase's dedicated-schema guidance](https://supabase.com/docs/guides/api/securing-your-api#dedicated-api-schemas).
The Go service uses direct PostgreSQL; the browser does not need database
credentials or Supabase table access.

## Staging verification before enabling enforcement

1. Use a separate staging database and set `ATO_MODE=shadow`. This overrides
   the checked-in `mode: enforce` and appends `.mode-shadow` to the config
   version recorded on every decision. Invalid overrides prevent startup.
2. Migrate and start the API, then check `/healthz` and analyst authentication.
3. Exercise ingestion and all analyst reads against staging. For the seed's
   expected hold/block sequence, use a separate disposable environment in
   enforcement mode: the seed deliberately asserts those actions. Run the
   simulator there to inspect false positives, missed takeovers, and latency.
4. Before relying on shadow traffic for operational evaluation, scrape
   `/metrics` (analyst token) and watch `ato_unscored_total{reason}`: health
   alone does not reveal fail-open scoring failures. Validate the 200 ms scoring
   budget against hosted Postgres.
5. Deploy the Next.js analyst UI from the `web` root to Vercel with `API_BASE_URL`,
   server-only `ANALYST_TOKEN`, and `UI_PASSWORD`. Keep the demo owner-response
   endpoint behind analyst authentication until signed owner links exist.
6. Enable enforcement after reviewing detection results and verifying the
   upstream send pipeline honors allow/flag/hold/block. Delivery of held mail and
   owner notification remain upstream integrations under spec assumptions A1–A4.

Keep the previous image and config version available for rollback. Database
migrations are forward-only; application rollback does not undo schema changes.

## Render with Supabase

`render.yaml` defines a free demo API service in Virginia, near the Supabase
database in US East. After 15 minutes without traffic, Render puts the service
to sleep; the next request wakes it with a cold-start delay. The hold-expiry
ticker pauses while the service sleeps and resumes after startup.
The definition uses Docker, `/app/server` for startup, `/healthz` for readiness,
and a 15-second shutdown window. Auto-deploy is set to **After CI Checks Pass**.
Render waits for GitHub checks on each new commit; it does not auto-deploy commits
with no checks.
For a service created manually, select the same auto-deploy option in its Render
settings. See Render's
[Blueprint reference](https://render.com/docs/blueprint-spec).

Free web services do not support Render's pre-deploy command. Supabase is
already migrated, so no migration hook is configured. Before a future release
with schema changes, run the migration command locally against Supabase using
the migration URL in `.env.supabase`, then deploy the API. Keep database
credentials out of Docker build steps.

```sh
docker build -t accountguard:local .
docker run --rm --env-file .env.supabase --entrypoint /app/migrate accountguard:local
```

The Blueprint was validated against Render's published JSON Schema. The image
also passed migration-command, health, analyst-read, authentication, and shadow
startup checks against Supabase while listening on Render's port 10000. The full
PostgreSQL-backed suite passed with race detection after the image change.

Supabase is already initialized: the private `ato` schema contains the app tables
and migration history. The actual server and migration commands were verified
against it in shadow mode, with no test events left behind. Supabase's `anon`
and `authenticated` roles have no usage access to the schema.

1. Open the [Render Dashboard](https://dashboard.render.com/) and connect GitHub.
   Create a Blueprint from `poojadesai14/accountguard`, selecting branch
   `render-deployment` and the root `render.yaml` file.
2. Render prompts for the three secrets marked `sync: false`. Copy their values
   from the ignored, owner-readable `.env.supabase` file:
   `DATABASE_URL`, `INGEST_TOKEN`, and `ANALYST_TOKEN`.
   The database URL points to the existing Supabase `ato` schema. No additional
   Render database is needed.
3. Confirm the service plan is **Free** and create `accountguard-api`. Render
   builds the image and starts the API against the existing database. See
   [free service limits](https://render.com/docs/free).
4. Open the generated HTTPS service URL and check `/healthz`. Confirm analyst
   requests require the analyst bearer token. Verify a suspicious test event
   returns `action: allow`, `enforced: false`, and a config version ending in
   `.mode-shadow`.

Render supplies `PORT`; the server reads it directly. The API and database
credentials remain server-side. The Vercel UI uses the Render API
URL and analyst token from its server environment.

The Blueprint deliberately deploys the review branch so the current main branch
does not need to change for the first staging deployment. After merging, switch
its `branch` setting to `main` and sync the Blueprint. `ATO_MODE` controls the
server only; run the deterministic seed in a separate disposable enforcement
environment.

Verify that **Backend tests** passes on the deployment branch.
`autoDeployTrigger: checksPass` is configured; Render automatically deploys
subsequent commits after CI succeeds.
