// Command server runs the ATO detection HTTP service.
package main

import (
	"context"
	"errors"
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

	cfg, err := config.Load(envOr("CONFIG_PATH", "config.yaml"))
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

	apiServer := &api.Server{
		Store:        db,
		Service:      &engine.Service{Store: db, Config: cfg},
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

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
