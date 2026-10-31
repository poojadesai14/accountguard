package main

import (
	"strings"
	"testing"
)

func TestHostedModeOverride(t *testing.T) {
	t.Setenv("CONFIG_PATH", "../../config.yaml")
	for _, mode := range []string{"shadow", "enforce", "invalid"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("ATO_MODE", mode)
			cfg, err := loadConfig()
			if mode == "invalid" {
				if err == nil || !strings.Contains(err.Error(), "ATO_MODE") {
					t.Fatalf("invalid mode must prevent startup: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Mode != mode || !strings.HasSuffix(cfg.Version, ".mode-"+mode) {
				t.Fatalf("mode override must be traceable in decisions: %+v", cfg)
			}
		})
	}
}
