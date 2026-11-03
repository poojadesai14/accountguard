package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/poojadesai14/resend-ato/internal/store"
)

// getDashboard serves the triage list: accounts needing attention, flagged
// accounts or accounts with healthy baselines, pending holds, or suspended keys,
// filtered and paged.
func (s *Server) getDashboard(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	segment := q.Get("segment")
	if segment == "" {
		segment = "attention"
	}
	severity := q.Get("severity")
	if severity == "" {
		severity = "all"
	}
	view := q.Get("view")
	if view == "" {
		view = "accounts"
	}
	if (view != "accounts" && view != "holds" && view != "keys" && view != "flagged" && view != "healthy") ||
		(view == "healthy" && segment != "baseline") ||
		((view == "holds" || view == "keys" || view == "flagged") && segment != "attention") {
		writeError(w, http.StatusBadRequest, "invalid dashboard view")
		return
	}
	sort := q.Get("sort")
	if sort == "" {
		sort = "priority"
	}
	if sort != "priority" && sort != "recent" {
		writeError(w, http.StatusBadRequest, "invalid dashboard sort")
		return
	}
	search := strings.TrimSpace(q.Get("q"))
	if (segment != "attention" && segment != "baseline") || (severity != "all" && severity != "flag" && severity != "hold" && severity != "block") || len(search) > 200 {
		writeError(w, http.StatusBadRequest, "invalid dashboard filter")
		return
	}
	page, ok := pageNumber(w, r, "page", 1, 1000000)
	if !ok {
		return
	}
	limit, ok := pageNumber(w, r, "limit", 50, 1000000)
	if !ok {
		return
	}
	limit = min(limit, 200)
	result, err := store.GetDashboard(r.Context(), s.Store.Pool, store.DashboardFilter{
		Segment: segment, Query: search, Severity: severity, Sort: sort, View: view, Page: page, Limit: limit,
		MinEvents: s.Config.Baseline.MinEvents, MinActiveHours: s.Config.Velocity.MinActiveHours,
	})
	if result != nil {
		result.EngineMode = s.Config.Mode
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, r, result, err)
}

// pageNumber reads an optional positive integer query parameter, at most maxValue.
func pageNumber(w http.ResponseWriter, r *http.Request, name string, fallback, maxValue int) (int, bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > maxValue {
		writeError(w, http.StatusBadRequest, name+" is outside the supported range")
		return 0, false
	}
	return n, true
}
