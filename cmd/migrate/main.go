// Command migrate applies the embedded SQL migrations to $DATABASE_URL.
package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/poojadesai14/resend-ato/internal/store"
	"github.com/poojadesai14/resend-ato/migrations"
)

func main() {
	ctx := context.Background()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		slog.Error("DATABASE_URL is not set")
		os.Exit(1)
	}
	s, err := store.Open(ctx, url)
	if err != nil {
		slog.Error("open database", "err", err)
		os.Exit(1)
	}
	defer s.Close()

	if err := store.Migrate(ctx, s.Pool, migrations.FS); err != nil {
		slog.Error("migrate", "err", err)
		os.Exit(1)
	}
	slog.Info("migrations up to date")
}
