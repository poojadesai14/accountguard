// Package api holds the HTTP handlers.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/poojadesai14/accountguard/internal/config"
	"github.com/poojadesai14/accountguard/internal/engine"
	"github.com/poojadesai14/accountguard/internal/event"
	"github.com/poojadesai14/accountguard/internal/metrics"
	"github.com/poojadesai14/accountguard/internal/signal"
	"github.com/poojadesai14/accountguard/internal/store"
)

const (
	maxEventBytes                = 1 << 20
	defaultSuspendedCheckTimeout = 50 * time.Millisecond
	// Below the server's WriteTimeout, so a slow analyst query is cancelled and
	// answered instead of left running on a closed connection.
	analystTimeout = 20 * time.Second
)

// Server serves the ingest, analyst and metrics endpoints.
type Server struct {
	Store        *store.Store
	Service      *engine.Service
	Config       *config.Config
	IngestToken  string
	AnalystToken string
	Metrics      *metrics.Metrics // optional; serves GET /metrics when set
	// SuspendedCheckTimeout bounds the suspended-key lookup when scoring fails.
	// Zero means 50 ms.
	SuspendedCheckTimeout time.Duration
}

// Routes returns the handler for every endpoint.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.Handle("POST /v1/events", bearer(s.IngestToken, http.HandlerFunc(s.postEvent)))
	if s.Metrics != nil {
		// Counts only, but the hosted URL is public, so it needs the analyst token.
		mux.Handle("GET /metrics", bearer(s.AnalystToken, s.Metrics.Handler()))
	}
	s.analystRoutes(mux)
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

	d, err := s.score(r.Context(), &ev)
	if err != nil {
		s.failOpen(w, r, &ev, err)
		return
	}

	action := d.Action
	if !d.Enforced {
		action = "allow"
	}
	writeJSON(w, http.StatusOK, DecisionResponse{
		EventID: d.EventID, DecisionID: d.DecisionID, Action: action, Enforced: d.Enforced,
		Score: d.Score, Hits: d.Hits, Reason: d.Reason,
		ConfigVersion: d.ConfigVersion, LatencyUS: d.LatencyUS,
	})
}

var errScoringPanic = errors.New("panic while scoring")

// score runs the engine and turns a panic into an error, so a bug in a signal
// fails open like a database outage instead of dropping the connection.
func (s *Server) score(ctx context.Context, ev *event.Event) (d *store.Decision, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("%w: %v", errScoringPanic, p)
		}
	}()
	return s.Service.Handle(ctx, ev)
}

// failOpen answers allow when an event couldn't be scored: a detector outage must
// not stop every customer's email. A key that is already suspended stays
// stopped, because that needs one indexed read, not the whole scoring path.
func (s *Server) failOpen(w http.ResponseWriter, r *http.Request, ev *event.Event, err error) {
	slog.Error("scoring failed, failing open", "event_id", ev.EventID, "account_id", ev.AccountID, "err", err)
	s.Metrics.Unscored(unscoredReason(err))
	resp := DecisionResponse{
		EventID: ev.EventID, Action: "allow", Hits: []signal.Hit{},
		Unscored: true, ConfigVersion: s.Config.Version,
	}
	if ev.APIKeyID != "" {
		budget := s.SuspendedCheckTimeout
		if budget == 0 {
			budget = defaultSuspendedCheckTimeout
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), budget)
		defer cancel()
		suspended, kerr := store.KeySuspended(ctx, s.Store.Pool, ev.APIKeyID)
		if kerr != nil {
			slog.Error("suspended-key check failed", "event_id", ev.EventID, "err", kerr)
		}
		if suspended {
			reason := engine.ReasonKeySuspended
			resp.Action, resp.Enforced, resp.Reason = "block", true, &reason
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func unscoredReason(err error) string {
	switch {
	case errors.Is(err, errScoringPanic):
		return metrics.UnscoredPanic
	case errors.Is(err, context.DeadlineExceeded):
		return metrics.UnscoredTimeout
	default:
		return metrics.UnscoredError
	}
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

func withTimeout(d time.Duration, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), d)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
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
