// Package migrations embeds the SQL schema files so the binary can apply them anywhere
// (local Docker, Supabase) without a separate migration tool.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
