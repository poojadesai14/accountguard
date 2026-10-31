package main

import (
	"strings"
	"testing"
)

func TestHostedModeOverride(t *testing.T) {
	tests := []struct {
		name              string
		mode              string
		wantMode          string
		wantVersionSuffix string
		wantError         string
	}{
		{
			name:              "shadow override",
			mode:              "shadow",
			wantMode:          "shadow",
			wantVersionSuffix: ".mode-shadow",
		},
		{
			name:              "enforcement override",
			mode:              "enforce",
			wantMode:          "enforce",
			wantVersionSuffix: ".mode-enforce",
		},
		{
			name:      "invalid override prevents startup",
			mode:      "invalid",
			wantError: "ATO_MODE",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("CONFIG_PATH", "../../config.yaml")
			t.Setenv("ATO_MODE", tt.mode)
			cfg, err := loadConfig()
			if tt.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantError) {
					t.Fatalf("loadConfig() error = %v, want containing %q", err, tt.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Mode != tt.wantMode {
				t.Errorf("mode = %q, want %q", cfg.Mode, tt.wantMode)
			}
			if !strings.HasSuffix(cfg.Version, tt.wantVersionSuffix) {
				t.Errorf("version = %q, want suffix %q", cfg.Version, tt.wantVersionSuffix)
			}
		})
	}
}
