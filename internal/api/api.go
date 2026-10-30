// Package api holds the HTTP handlers.
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/engine"
	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/signal"
	"github.com/poojadesai14/resend-ato/internal/store"
)

const maxEventBytes = 1 << 20

type Server struct {
	Store        *store.Store
	Service      *engine.Service
	Config       *config.Config
	IngestToken  string
	AnalystToken string
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.Handle("POST /v1/events", bearer(s.IngestToken, http.HandlerFunc(s.postEvent)))
	return mux
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.Ping(r.Context()); err != nil {
		http.Error(w, "db unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Write([]byte("ok"))
}

// DecisionResponse is what the send pipeline acts on. Action is "allow" whenever the
// decision isn't enforced (shadow mode) or the event couldn't be scored (fail open).
type DecisionResponse struct {
	EventID       string       `json:"event_id"`
	DecisionID    string       `json:"decision_id,omitempty"`
	Action        string       `json:"action"`
	Enforced      bool         `json:"enforced"`
	Score         int          `json:"score"`
	Hits          []signal.Hit `json:"hits"`
	Reason        *string      `json:"reason"`
	Unscored      bool         `json:"unscored"`
	ConfigVersion string       `json:"config_version"`
	LatencyUS     int          `json:"latency_us"`
}

func (s *Server) postEvent(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxEventBytes)
	var ev event.Event
	if err := json.NewDecoder(r.Body).Decode(&ev); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "event larger than 1 MB")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if err := ev.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	d, err := s.Service.Handle(r.Context(), &ev)
	if err != nil {
		// Fail open: a detector outage must not stop every customer's email.
		slog.Error("scoring failed, failing open", "event_id", ev.EventID, "account_id", ev.AccountID, "err", err)
		writeJSON(w, http.StatusOK, DecisionResponse{
			EventID: ev.EventID, Action: "allow", Hits: []signal.Hit{},
			Unscored: true, ConfigVersion: s.Config.Version,
		})
		return
	}

	action := d.Action
	if !d.Enforced {
		action = "allow"
	}
	writeJSON(w, http.StatusOK, DecisionResponse{
		EventID: d.EventID, DecisionID: d.DecisionID, Action: action, Enforced: d.Enforced,
		Score: d.Score, Hits: d.Hits, Reason: d.Reason, Unscored: d.Unscored,
		ConfigVersion: d.ConfigVersion, LatencyUS: d.LatencyUS,
	})
}

func bearer(token string, next http.Handler) http.Handler {
	want := []byte("Bearer " + token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(strings.TrimSpace(r.Header.Get("Authorization")))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			writeError(w, http.StatusUnauthorized, "missing or invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
