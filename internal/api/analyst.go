package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/accountguard/internal/engine"
	"github.com/poojadesai14/accountguard/internal/event"
	"github.com/poojadesai14/accountguard/internal/signal"
	"github.com/poojadesai14/accountguard/internal/store"
)

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (s *Server) analystRoutes(mux *http.ServeMux) {
	auth := func(h http.HandlerFunc) http.Handler { return bearer(s.AnalystToken, withTimeout(analystTimeout, h)) }
	mux.Handle("GET /v1/config", auth(s.getConfig))
	mux.Handle("GET /v1/dashboard", auth(s.getDashboard))
	mux.Handle("GET /v1/analyst-actions", auth(s.listAnalystActions))
	mux.Handle("GET /v1/stats", auth(s.getStats))
	mux.Handle("GET /v1/accounts", auth(s.listAccounts))
	mux.Handle("GET /v1/accounts/{id}/timeline", auth(s.getTimeline))
	mux.Handle("GET /v1/accounts/{id}/series", auth(s.getSeries))
	mux.Handle("GET /v1/accounts/{id}/profile", auth(s.getProfile))
	mux.Handle("GET /v1/decisions/{id}", auth(s.getDecision))
	mux.Handle("POST /v1/decisions/{id}/actions", auth(s.postAction))
	mux.Handle("POST /v1/keys/{key_id}/unblock", auth(s.postUnblock))
	mux.Handle("POST /v1/keys/{key_id}/suspend", auth(s.postSuspendKey))
	mux.Handle("POST /v1/accounts/{id}/resolve", auth(s.postResolveAccount))
	mux.Handle("POST /v1/accounts/{id}/correct", auth(s.postCorrectToTakeover))
	// Demo: the owner's hold link uses the analyst token. Production: a signed one-time link.
	mux.Handle("POST /v1/holds/{id}/owner-response", auth(s.postOwnerResponse))
}

// getConfig is what every UI page needs about the engine: the mode (so shadow
// decisions are never presented as enforced) and the thresholds behind each action.
func (s *Server) getConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"mode": s.Config.Mode, "config_version": s.Config.Version, "thresholds": s.thresholds(),
	})
}

func (s *Server) getStats(w http.ResponseWriter, r *http.Request) {
	rng, ok := parseRange(w, r)
	if !ok {
		return
	}
	bucket := map[string]string{"": "hour", "1h": "hour", "1d": "day"}[r.URL.Query().Get("bucket")]
	if bucket == "" {
		writeError(w, http.StatusBadRequest, "bucket must be 1h or 1d")
		return
	}
	stats, err := store.GetStats(r.Context(), s.Store.Pool, rng, bucket)
	respond(w, r, stats, err)
}

func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	accounts, err := store.ListAccounts(r.Context(), s.Store.Pool, q.Get("q"), q.Get("needs_review") == "true")
	respond(w, r, accounts, err)
}

func (s *Server) getTimeline(w http.ResponseWriter, r *http.Request) {
	rng, ok := parseRange(w, r)
	if !ok {
		return
	}
	limit := 1000
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 5000 {
			writeError(w, http.StatusBadRequest, "limit must be 1-5000")
			return
		}
		limit = n
	}
	rows, err := store.Timeline(r.Context(), s.Store.Pool, r.PathValue("id"), rng, limit)
	respond(w, r, rows, err)
}

type seriesASN struct {
	ASN       int    `json:"asn"`
	Org       string `json:"org"`
	FirstSeen bool   `json:"first_seen"`
}

type seriesPoint struct {
	T              time.Time      `json:"t"`
	Recipients     int            `json:"recipients"`
	ASNs           []seriesASN    `json:"asns"`
	ContentHits    []string       `json:"content_hits"`
	AccountChanges int            `json:"account_changes"`
	Actions        map[string]int `json:"actions"`
}

// getSeries returns hourly points for the account page charts, which share one time axis.
// The baseline is the current learned value; per-hour history of the baseline isn't stored.
func (s *Server) getSeries(w http.ResponseWriter, r *http.Request) {
	rng, ok := parseRange(w, r)
	if !ok {
		return
	}
	ctx, id := r.Context(), r.PathValue("id")
	p, err := store.GetProfile(ctx, s.Store.Pool, id)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	evs, err := store.SeriesEvents(ctx, s.Store.Pool, id, rng)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	v := s.Config.Velocity
	writeJSON(w, http.StatusOK, map[string]any{
		"account_id":      id,
		"baseline_hourly": p.HourlyEWMA,
		"spike_threshold": v.Multiplier * max(p.HourlyEWMA, v.MinHourlyBaseline),
		"points":          seriesPoints(evs),
	})
}

// seriesPoints buckets events (in time order) by UTC hour. An ASN is listed once
// per hour, marked first_seen in the hour the account first used it.
func seriesPoints(evs []store.SeriesEvent) []seriesPoint {
	points := []seriesPoint{}
	for _, e := range evs {
		h := e.OccurredAt.UTC().Truncate(time.Hour)
		if len(points) == 0 || !points[len(points)-1].T.Equal(h) {
			points = append(points, seriesPoint{T: h, ASNs: []seriesASN{}, ContentHits: []string{}, Actions: map[string]int{}})
		}
		pt := &points[len(points)-1]
		pt.Recipients += e.RecipientCount
		if e.Type == event.TypeAccountChange {
			pt.AccountChanges++
		}
		if e.Action != "" {
			pt.Actions[e.Action]++
		}
		if e.ASN != nil && !slices.ContainsFunc(pt.ASNs, func(a seriesASN) bool { return a.ASN == *e.ASN }) {
			first := e.ASNFirstSeen.UTC().Truncate(time.Hour).Equal(h)
			pt.ASNs = append(pt.ASNs, seriesASN{ASN: *e.ASN, Org: e.ASNOrg, FirstSeen: first})
		}
		for _, hit := range e.Hits {
			if hit.Category == signal.CatContent && !slices.Contains(pt.ContentHits, hit.Name) {
				pt.ContentHits = append(pt.ContentHits, hit.Name)
			}
		}
	}
	return points
}

func (s *Server) getProfile(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), r.PathValue("id")
	p, err := store.GetProfile(ctx, s.Store.Pool, id)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	keys, err := store.KeyStatuses(ctx, s.Store.Pool, id)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	open, err := store.AccountOpenCounts(ctx, s.Store.Pool, id)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	legitimate, err := store.LegitimateDecisions(ctx, s.Store.Pool, id)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	created, err := store.CreatedKeys(ctx, s.Store.Pool, id)
	respond(w, r, map[string]any{"profile": p, "key_status": keys, "open": open, "legitimate_decisions": legitimate,
		"created_keys": created}, err)
}

func (s *Server) getDecision(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), r.PathValue("id")
	if !uuidRe.MatchString(id) {
		writeError(w, http.StatusNotFound, "decision not found")
		return
	}
	d, err := store.DecisionByID(ctx, s.Store.Pool, id, false)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	ev, err := store.EventRow(ctx, s.Store.Pool, d.EventID)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	actions, err := store.ActionsForDecision(ctx, s.Store.Pool, id)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	related, err := store.RelatedIndicators(ctx, s.Store.Pool, d.AccountID, ev, s.Config.Content.Freemail, relatedWindow)
	if err != nil {
		respond(w, r, nil, err)
		return
	}
	// The event's key as it is now, so a review can show what is left to do
	// (a suspended key is restored by a separate, audited action).
	var key *store.KeyStatus
	if d.APIKeyID != nil {
		if key, err = store.KeyStatusOf(ctx, s.Store.Pool, d.AccountID, *d.APIKeyID); err != nil {
			respond(w, r, nil, err)
			return
		}
	}
	respond(w, r, map[string]any{"decision": d, "event": ev, "actions": actions, "thresholds": s.thresholds(), "related": related, "key": key}, nil)
}

// relatedWindow is how far either side of an event to look for the same indicators
// on other accounts: long enough to catch a campaign, short enough that a shared
// domain from months ago doesn't count.
const relatedWindow = 7 * 24 * time.Hour

// Thresholds lets the UI explain a decision with the same numbers the engine used.
type Thresholds struct {
	Flag                 int      `json:"flag"`
	Hold                 int      `json:"hold"`
	Block                int      `json:"block"`
	BlockMinCategories   int      `json:"block_min_categories"`
	SingleCategoryExempt []string `json:"single_category_exempt"`
}

func (s *Server) thresholds() Thresholds {
	t := s.Config.Thresholds
	return Thresholds{
		Flag: t.Flag, Hold: t.Hold, Block: t.Block,
		BlockMinCategories: t.BlockMinCategories, SingleCategoryExempt: t.SingleCategoryExempt,
	}
}

type actionRequest struct {
	Action  string `json:"action"`
	Confirm string `json:"confirm"` // the account ID, to mark risky evidence legitimate
	Actor   string `json:"actor"`
	Reason  string `json:"reason"`
}

func (req actionRequest) who() engine.Who { return engine.Who{Actor: req.Actor, Reason: req.Reason} }

func (s *Server) postAction(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		writeError(w, http.StatusNotFound, "decision not found")
		return
	}
	var req actionRequest
	if !decodeBody(w, r, &req) || !requireActor(w, req) {
		return
	}
	d, err := s.Service.ApplyAction(r.Context(), id, req.Action, req.Confirm, req.who())
	respond(w, r, d, err)
}

func (s *Server) postUnblock(w http.ResponseWriter, r *http.Request) {
	var req actionRequest
	if !decodeBody(w, r, &req) || !requireActor(w, req) {
		return
	}
	err := s.Service.UnblockKey(r.Context(), r.PathValue("key_id"), req.Confirm, req.who())
	respond(w, r, map[string]string{"api_key_id": r.PathValue("key_id"), "status": "active"}, err)
}

// postSuspendKey suspends a key on an analyst's authority.
func (s *Server) postSuspendKey(w http.ResponseWriter, r *http.Request) {
	var req actionRequest
	if !decodeBody(w, r, &req) || !requireActor(w, req) {
		return
	}
	dropped, err := s.Service.SuspendKey(r.Context(), r.PathValue("key_id"), req.who())
	respond(w, r, map[string]any{"api_key_id": r.PathValue("key_id"), "status": "suspended", "holds_dropped": dropped}, err)
}

// postCorrectToTakeover relabels decisions wrongly marked legitimate as takeover.
func (s *Server) postCorrectToTakeover(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DecisionIDs []string `json:"decision_ids"`
		Actor       string   `json:"actor"`
		Reason      string   `json:"reason"`
	}
	if !decodeBody(w, r, &req) || !requireActor(w, actionRequest{Actor: req.Actor, Reason: req.Reason}) {
		return
	}
	if len(req.DecisionIDs) == 0 || len(req.DecisionIDs) > 200 || slices.ContainsFunc(req.DecisionIDs, func(id string) bool { return !uuidRe.MatchString(id) }) {
		writeError(w, http.StatusBadRequest, "decision_ids must list 1 to 200 decision IDs")
		return
	}
	res, err := s.Service.CorrectToTakeover(r.Context(), r.PathValue("id"), req.DecisionIDs, engine.Who{Actor: req.Actor, Reason: req.Reason})
	respond(w, r, res, err)
}

// postResolveAccount closes every open review on an account with one outcome.
func (s *Server) postResolveAccount(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DecisionIDs []string `json:"decision_ids"` // the open reviews the analyst saw
		Outcome     string   `json:"outcome"`
		RestoreKeys bool     `json:"restore_keys"`
		Confirm     string   `json:"confirm"` // the account ID, when the reviews show risky signals
		Actor       string   `json:"actor"`
		Reason      string   `json:"reason"`
	}
	if !decodeBody(w, r, &req) || !requireActor(w, actionRequest{Actor: req.Actor, Reason: req.Reason}) {
		return
	}
	res, err := s.Service.ResolveAccount(r.Context(), r.PathValue("id"), engine.ResolveRequest{
		Seen: req.DecisionIDs, Outcome: req.Outcome, RestoreKeys: req.RestoreKeys, Confirm: req.Confirm,
		Who: engine.Who{Actor: req.Actor, Reason: req.Reason},
	})
	respond(w, r, res, err)
}

func (s *Server) postOwnerResponse(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		writeError(w, http.StatusNotFound, "hold not found")
		return
	}
	var req struct {
		Response string `json:"response"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	d, err := s.Service.OwnerRespond(r.Context(), id, req.Response)
	respond(w, r, d, err)
}

func requireActor(w http.ResponseWriter, req actionRequest) bool {
	if strings.TrimSpace(req.Actor) == "" || strings.TrimSpace(req.Reason) == "" {
		writeError(w, http.StatusBadRequest, "actor and reason are required")
		return false
	}
	return true
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

// parseRange reads optional RFC 3339 from/to query parameters.
func parseRange(w http.ResponseWriter, r *http.Request) (store.Range, bool) {
	var rng store.Range
	for name, dst := range map[string]**time.Time{"from": &rng.From, "to": &rng.To} {
		v := r.URL.Query().Get(name)
		if v == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, name+" must be RFC 3339, e.g. 2026-10-30T00:00:00Z")
			return rng, false
		}
		*dst = &t
	}
	return rng, true
}

// respond writes v, or maps err to a status code.
func respond(w http.ResponseWriter, r *http.Request, v any, err error) {
	var (
		conflict *engine.ConflictError
		invalid  *engine.ValidationError
	)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, v)
	case errors.Is(err, engine.ErrNotFound), errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "not found")
	case errors.As(err, &invalid):
		writeError(w, http.StatusBadRequest, invalid.Msg)
	case errors.As(err, &conflict):
		writeError(w, http.StatusConflict, conflict.Msg)
	default:
		slog.Error("analyst api error", "route", r.Pattern, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}
