// Command server runs the ATO detection HTTP service.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/poojadesai14/resend-ato/internal/api"
	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/engine"
	"github.com/poojadesai14/resend-ato/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	for _, k := range []string{"DATABASE_URL", "INGEST_TOKEN", "ANALYST_TOKEN"} {
		if os.Getenv(k) == "" {
			return errors.New(k + " is not set")
		}
	}

	db, err := store.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer db.Close()

	svc := &engine.Service{Store: db, Config: cfg}
	go expireHolds(ctx, db, cfg.Hold.Tick)

	apiServer := &api.Server{
		Store:        db,
		Service:      svc,
		Config:       cfg,
		IngestToken:  os.Getenv("INGEST_TOKEN"),
		AnalystToken: os.Getenv("ANALYST_TOKEN"),
	}

	srv := &http.Server{
		Addr:              ":" + envOr("PORT", "8080"),
		Handler:           apiServer.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("listening", "addr", srv.Addr, "config_version", cfg.Version, "mode", cfg.Mode)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// loadConfig allows the hosted service to switch enforcement modes without
// rebuilding the image. Record the override in the decision's config version.
func loadConfig() (*config.Config, error) {
	cfg, err := config.Load(envOr("CONFIG_PATH", "config.yaml"))
	if err != nil {
		return nil, err
	}
	if mode := os.Getenv("ATO_MODE"); mode != "" {
		cfg.Mode = mode
		if err := cfg.Validate(); err != nil {
			return nil, fmt.Errorf("invalid ATO_MODE: %w", err)
		}
		cfg.Version += ".mode-" + mode
	}
	return cfg, nil
}

// expireHolds marks holds nobody answered as expired (SPEC §7). Uses wall clock.
func expireHolds(ctx context.Context, db *store.Store, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := store.ExpireHolds(ctx, db.Pool)
			if err != nil {
				slog.Error("expire holds", "err", err)
			} else if n > 0 {
				slog.Info("holds expired", "count", n)
			}
		}
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
