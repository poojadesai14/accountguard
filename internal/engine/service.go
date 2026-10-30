package engine

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/signal"
	"github.com/poojadesai14/resend-ato/internal/store"
)

// Service scores events inside one transaction: save event, lock profile, compare,
// decide, save decision, then update the profile (SPEC §5.2).
type Service struct {
	Store  *store.Store
	Config *config.Config
}

// Handle returns the decision for ev. A duplicate event_id returns the original decision.
// Any error means the event was not scored; the caller fails open.
func (s *Service) Handle(ctx context.Context, ev *event.Event) (*store.Decision, error) {
	start := time.Now()
	cfg := s.Config
	ctx, cancel := context.WithTimeout(ctx, time.Duration(cfg.Scoring.TimeoutMS)*time.Millisecond)
	defer cancel()

	feats := event.Extract(ev)
	var (
		dec       *store.Decision
		duplicate bool
	)
	err := pgx.BeginFunc(ctx, s.Store.Pool, func(tx pgx.Tx) error {
		inserted, err := store.InsertEvent(ctx, tx, ev, feats)
		if err != nil {
			return err
		}
		if !inserted {
			duplicate = true
			dec, err = store.DecisionByEvent(ctx, tx, ev.EventID)
			return err
		}

		p, err := store.LockProfile(ctx, tx, ev.AccountID, ev.OccurredAt)
		if err != nil {
			return err
		}
		suspended := false
		if ev.APIKeyID != "" {
			if suspended, err = store.KeySuspended(ctx, tx, ev.APIKeyID); err != nil {
				return err
			}
		}
		window := 0
		if ev.Type == event.TypeEmailSend {
			if window, err = store.WindowRecipients(ctx, tx, ev.AccountID, ev.OccurredAt, cfg.Velocity.Window); err != nil {
				return err
			}
		}

		// Compare first...
		res := Evaluate(&signal.Input{Event: ev, Features: feats, Profile: p, WindowRecipients: window, Config: cfg}, suspended)

		enforced := cfg.Mode == "enforce"
		dec = &store.Decision{
			EventID:       ev.EventID,
			AccountID:     ev.AccountID,
			APIKeyID:      nullable(ev.APIKeyID),
			OccurredAt:    ev.OccurredAt,
			Action:        res.Action.String(),
			Enforced:      enforced,
			Score:         res.Score,
			Hits:          res.Hits,
			Reason:        nullable(res.Reason),
			ConfigVersion: cfg.Version,
			ReviewStatus:  "none",
		}
		if res.Action >= Flag {
			dec.ReviewStatus = "open"
		}
		if enforced && res.Action == Hold {
			now := time.Now()
			expires := now.Add(cfg.Hold.TTL)
			pending := "pending"
			dec.HoldStatus, dec.HoldExpiresAt, dec.OwnerNotifiedAt = &pending, &expires, &now
		}
		dec.LatencyUS = int(time.Since(start).Microseconds())
		if err := store.InsertDecision(ctx, tx, dec); err != nil {
			return err
		}
		if enforced && res.Action == Block && res.Reason != ReasonKeySuspended && ev.APIKeyID != "" {
			if err := store.SuspendKey(ctx, tx, ev.APIKeyID, ev.AccountID, "auto", dec.DecisionID); err != nil {
				return err
			}
		}

		// ...then update. Only allowed events teach the baseline.
		p.RecordAlways(ev, cfg)
		if res.Action == Allow {
			p.Learn(ev, feats, cfg)
		}
		return store.SaveProfile(ctx, tx, p)
	})
	if err != nil {
		return nil, err
	}

	if !duplicate {
		names := make([]string, len(dec.Hits))
		for i, h := range dec.Hits {
			names[i] = h.Name
		}
		slog.Info("decision",
			"event_id", dec.EventID, "account_id", dec.AccountID, "api_key_id", ev.APIKeyID, "type", ev.Type,
			"action", dec.Action, "enforced", dec.Enforced, "score", dec.Score, "hits", names,
			"config_version", dec.ConfigVersion, "latency_us", dec.LatencyUS)
	}
	return dec, nil
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
