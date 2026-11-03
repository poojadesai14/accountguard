package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoad(t *testing.T) {
	base, err := os.ReadFile("../../config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct{ name, replace, replacement, wantError string }{
		{
			name: "repository configuration",
		},
		{
			name:        "invalid engine mode",
			replace:     "mode: enforce",
			replacement: "mode: yolo",
			wantError:   "mode must be",
		},
		{
			name:        "thresholds out of order",
			replace:     "hold: 60",
			replacement: "hold: 10",
			wantError:   "thresholds must satisfy",
		},
		{
			name:        "unknown signal",
			replace:     "new_asn: 30",
			replacement: "new_asn: 30\n    new_ip: 5",
			wantError:   `unknown signal "new_ip"`,
		},
		{
			name:        "negative signal points",
			replace:     "recipient_spike: 15",
			replacement: "recipient_spike: -1",
			wantError:   "must be >= 0",
		},
		{
			name:        "unknown configuration field",
			replace:     "mode: enforce",
			replacement: "mode: enforce\nmodee: x",
			wantError:   "field modee not found",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := "../../config.yaml"
			if tt.replace != "" {
				if !strings.Contains(string(base), tt.replace) {
					t.Fatalf("fixture does not contain %q", tt.replace)
				}
				path = filepath.Join(t.TempDir(), "config.yaml")
				if err := os.WriteFile(path, []byte(strings.Replace(string(base), tt.replace, tt.replacement, 1)), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			cfg, err := Load(path)
			if tt.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantError) {
					t.Fatalf("Load() error = %v, want containing %q", err, tt.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := cfg.Points("new_asn"); got != 30 {
				t.Errorf("new_asn points = %d, want 30", got)
			}
			if _, ok := cfg.Content.DomainAges["invoice-portal.net"]; !ok {
				t.Error("configured domain age was not parsed")
			}
			if !cfg.Content.Freemail["gmail.com"] {
				t.Error("configured freemail set was not built")
			}
		})
	}
}

func TestParseDomainAge(t *testing.T) {
	today := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name, in  string
		want      time.Time
		wantError bool
	}{
		{name: "absolute date", in: "2026-10-26", want: time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)},
		{name: "days before today", in: "4d", want: time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)},
		{name: "registered today", in: "0d", want: today},
		{name: "negative days", in: "-3d", wantError: true},
		{name: "not a number", in: "fourd", wantError: true},
		{name: "not a date", in: "2026/10/26", wantError: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseDomainAge(tt.in, today)
			if tt.wantError {
				if err == nil {
					t.Fatalf("parseDomainAge(%q) = %v, want error", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !got.Equal(tt.want) {
				t.Errorf("parseDomainAge(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}
