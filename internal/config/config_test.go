package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadRepoConfig(t *testing.T) {
	c, err := Load("../../config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Points("new_asn"); got != 30 {
		t.Errorf("new_asn points = %d, want 30", got)
	}
	if _, ok := c.Content.DomainAges["invoice-portal.net"]; !ok {
		t.Error("domain_ages not parsed")
	}
	if !c.Content.Freemail["gmail.com"] {
		t.Error("freemail set not built")
	}
}

func TestValidateRejects(t *testing.T) {
	base, err := os.ReadFile("../../config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, from, to, wantErr string
	}{
		{"bad mode", "mode: enforce", "mode: yolo", "mode must be"},
		{"thresholds out of order", "hold: 60", "hold: 10", "thresholds must satisfy"},
		{"unknown signal", "new_asn: 30", "new_asn: 30\n    new_ip: 5", `unknown signal "new_ip"`},
		{"negative points", "recipient_spike: 15", "recipient_spike: -1", "must be >= 0"},
		{"unknown field", "mode: enforce", "mode: enforce\nmodee: x", "field modee not found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.yaml")
			os.WriteFile(path, []byte(strings.Replace(string(base), tt.from, tt.to, 1)), 0o600)
			_, err := Load(path)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}
