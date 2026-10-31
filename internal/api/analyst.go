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

	"github.com/poojadesai14/resend-ato/internal/engine"
	"github.com/poojadesai14/resend-ato/internal/store"
)

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (s *Server) analystRoutes(mux *http.ServeMux) {
	auth := func(h http.HandlerFunc) http.Handler { return bearer(s.AnalystToken, h) }
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
	// Demo: the owner's hold link uses the analyst token. Production: a signed one-time link.
	mux.Handle("POST /v1/holds/{id}/owner-response", auth(s.postOwnerResponse))
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
	respond(w, stats, err)
}

func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	accounts, err := store.ListAccounts(r.Context(), s.Store.Pool, q.Get("q"), q.Get("needs_review") == "true")
	respond(w, accounts, err)
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
	respond(w, rows, err)
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
		respond(w, nil, err)
		return
	}
	evs, err := store.SeriesEvents(ctx, s.Store.Pool, id, rng)
	if err != nil {
		respond(w, nil, err)
		return
	}

	points := []seriesPoint{}
	for _, e := range evs {
		h := e.OccurredAt.UTC().Truncate(time.Hour)
		if len(points) == 0 || !points[len(points)-1].T.Equal(h) {
			points = append(points, seriesPoint{T: h, ASNs: []seriesASN{}, ContentHits: []string{}, Actions: map[string]int{}})
		}
		pt := &points[len(points)-1]
		pt.Recipients += e.RecipientCount
		if e.Type == "account.change" {
			pt.AccountChanges++
		}
		if e.Action != "" {
			pt.Actions[e.Action]++
		}
		if e.ASN != nil {
			first := e.ASNFirstSeen.UTC().Truncate(time.Hour).Equal(h)
			found := false
			for i := range pt.ASNs {
				if pt.ASNs[i].ASN == *e.ASN {
					found = true
				}
			}
			if !found {
				pt.ASNs = append(pt.ASNs, seriesASN{ASN: *e.ASN, Org: e.ASNOrg, FirstSeen: first})
			}
		}
		for _, hit := range e.Hits {
			if hit.Category == "content" && !slices.Contains(pt.ContentHits, hit.Name) {
				pt.ContentHits = append(pt.ContentHits, hit.Name)
			}
		}
	}

	v := s.Config.Velocity
	writeJSON(w, http.StatusOK, map[string]any{
		"account_id":      id,
		"baseline_hourly": p.HourlyEWMA,
		"spike_threshold": v.Multiplier * max(p.HourlyEWMA, v.MinHourlyBaseline),
		"points":          points,
	})
}

func (s *Server) getProfile(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), r.PathValue("id")
	p, err := store.GetProfile(ctx, s.Store.Pool, id)
	if err != nil {
		respond(w, nil, err)
		return
	}
	keys, err := store.KeyStatuses(ctx, s.Store.Pool, id)
	respond(w, map[string]any{"profile": p, "key_status": keys}, err)
}

func (s *Server) getDecision(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), r.PathValue("id")
	if !uuidRe.MatchString(id) {
		writeError(w, http.StatusNotFound, "decision not found")
		return
	}
	d, err := store.DecisionByID(ctx, s.Store.Pool, id, false)
	if err != nil {
		respond(w, nil, err)
		return
	}
	ev, err := store.EventRow(ctx, s.Store.Pool, d.EventID)
	if err != nil {
		respond(w, nil, err)
		return
	}
	actions, err := store.ActionsForDecision(ctx, s.Store.Pool, id)
	respond(w, map[string]any{"decision": d, "event": ev, "actions": actions}, err)
}

type actionRequest struct {
	Action string `json:"action"`
	Actor  string `json:"actor"`
	Reason string `json:"reason"`
}

func (s *Server) postAction(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		writeError(w, http.StatusNotFound, "decision not found")
		return
	}
	var req actionRequest
	if !decodeBody(w, r, &req) {
		return
	}
	switch req.Action {
	case engine.ActConfirmTakeover, engine.ActMarkLegitimate, engine.ActReleaseHold:
	default:
		writeError(w, http.StatusBadRequest, "action must be confirm_takeover, mark_legitimate or release_hold")
		return
	}
	if !requireActor(w, req) {
		return
	}
	d, err := s.Service.ApplyAction(r.Context(), id, req.Action, req.Actor, req.Reason)
	respond(w, d, err)
}

func (s *Server) postUnblock(w http.ResponseWriter, r *http.Request) {
	var req actionRequest
	if !decodeBody(w, r, &req) || !requireActor(w, req) {
		return
	}
	err := s.Service.UnblockKey(r.Context(), r.PathValue("key_id"), req.Actor, req.Reason)
	respond(w, map[string]string{"api_key_id": r.PathValue("key_id"), "status": "active"}, err)
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
	if req.Response != "this_was_me" && req.Response != "not_me" {
		writeError(w, http.StatusBadRequest, "response must be this_was_me or not_me")
		return
	}
	d, err := s.Service.OwnerRespond(r.Context(), id, req.Response)
	respond(w, d, err)
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
func respond(w http.ResponseWriter, v any, err error) {
	var c *engine.ConflictError
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, v)
	case errors.Is(err, engine.ErrNotFound), errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "not found")
	case errors.As(err, &c):
		writeError(w, http.StatusConflict, c.Msg)
	default:
		slog.Error("analyst api error", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}
