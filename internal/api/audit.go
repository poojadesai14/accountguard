package api

import (
	"net/http"
	"strconv"

	"github.com/poojadesai14/resend-ato/internal/store"
)

// listAnalystActions pages the audit log of every analyst and owner action, newest first.
func (s *Server) listAnalystActions(w http.ResponseWriter, r *http.Request) {
	rng, ok := parseRange(w, r)
	if !ok {
		return
	}
	if rng.From != nil && rng.To != nil && !rng.From.Before(*rng.To) {
		writeError(w, http.StatusBadRequest, "from must precede to")
		return
	}
	limit, ok := pageNumber(w, r, "limit", 50, 1000000)
	if !ok {
		return
	}
	limit = min(limit, 200)
	var before int64
	if raw := r.URL.Query().Get("before_id"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "before_id must be a positive integer")
			return
		}
		before = n
	}
	result, err := store.ListAnalystActions(r.Context(), s.Store.Pool, rng, before, limit)
	w.Header().Set("Cache-Control", "no-store")
	respond(w, r, result, err)
}
