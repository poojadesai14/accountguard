// Package config loads and validates config.yaml. The service refuses to start on an invalid config.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"slices"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Version    string     `yaml:"version"`
	Mode       string     `yaml:"mode"`
	Scoring    Scoring    `yaml:"scoring"`
	Thresholds Thresholds `yaml:"thresholds"`
	Baseline   Baseline   `yaml:"baseline"`
	Network    Network    `yaml:"network"`
	Velocity   Velocity   `yaml:"velocity"`
	Content    Content    `yaml:"content"`
	Account    Account    `yaml:"account"`
	Hold       Hold       `yaml:"hold"`
}

type Scoring struct {
	TimeoutMS int `yaml:"timeout_ms"`
	MaxScore  int `yaml:"max_score"`
}

type Thresholds struct {
	Flag                 int      `yaml:"flag"`
	Hold                 int      `yaml:"hold"`
	Block                int      `yaml:"block"`
	BlockMinCategories   int      `yaml:"block_min_categories"`
	SingleCategoryCap    string   `yaml:"single_category_cap"`
	SingleCategoryExempt []string `yaml:"single_category_exempt"`
}

type Baseline struct {
	MinEvents       int `yaml:"min_events"`
	MaxKnownDomains int `yaml:"max_known_domains"`
}

type Network struct {
	MinKeyEvents int            `yaml:"min_key_events"`
	Points       map[string]int `yaml:"points"`
}

type Velocity struct {
	Window            time.Duration  `yaml:"window"`
	Multiplier        float64        `yaml:"multiplier"`
	MinHourlyBaseline float64        `yaml:"min_hourly_baseline"`
	MinActiveHours    int            `yaml:"min_active_hours"`
	EWMAAlpha         float64        `yaml:"ewma_alpha"`
	Points            map[string]int `yaml:"points"`
}

type Content struct {
	YoungDays            int               `yaml:"young_days"`
	LookalikeMaxDistance int               `yaml:"lookalike_max_distance"`
	LookalikeMinLen      int               `yaml:"lookalike_min_len"`
	Points               map[string]int    `yaml:"points"`
	FreemailDomains      []string          `yaml:"freemail_domains"`
	DomainAgesRaw        map[string]string `yaml:"domain_ages"`

	// Parsed from DomainAgesRaw by Load.
	DomainAges map[string]time.Time `yaml:"-"`
	Freemail   map[string]bool      `yaml:"-"`
}

type Account struct {
	Window                 time.Duration  `yaml:"window"`
	ReconResources         []string       `yaml:"recon_resources"`
	FirstReadMinAccountAge time.Duration  `yaml:"first_read_min_account_age"`
	Points                 map[string]int `yaml:"points"`
}

type Hold struct {
	TTL          time.Duration `yaml:"ttl"`
	Tick         time.Duration `yaml:"tick"`
	ExpireAction string        `yaml:"expire_action"`
}

// knownSignals lists every hit name per config section. Points for anything else is a config error.
var knownSignals = map[string][]string{
	"network":  {"new_asn"},
	"velocity": {"recipient_spike"},
	"content":  {"new_domain", "young_domain", "lookalike_domain", "freemail_reply_to"},
	"account":  {"recent_account_change", "first_read"},
}

func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := c.parse(); err != nil {
		return nil, err
	}
	if err := c.Validate(); err != nil {
		return nil, fmt.Errorf("invalid %s: %w", path, err)
	}
	return &c, nil
}

func (c *Config) parse() error {
	c.Content.DomainAges = make(map[string]time.Time, len(c.Content.DomainAgesRaw))
	for d, s := range c.Content.DomainAgesRaw {
		t, err := time.Parse("2006-01-02", s)
		if err != nil {
			return fmt.Errorf("content.domain_ages[%s]: %w", d, err)
		}
		c.Content.DomainAges[d] = t
	}
	c.Content.Freemail = make(map[string]bool, len(c.Content.FreemailDomains))
	for _, d := range c.Content.FreemailDomains {
		c.Content.Freemail[d] = true
	}
	return nil
}

func (c *Config) Validate() error {
	var errs []error
	add := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }

	if c.Version == "" {
		add("version is required")
	}
	if c.Mode != "enforce" && c.Mode != "shadow" {
		add("mode must be enforce or shadow, got %q", c.Mode)
	}
	t := c.Thresholds
	if !(0 < t.Flag && t.Flag < t.Hold && t.Hold < t.Block && t.Block <= c.Scoring.MaxScore) {
		add("thresholds must satisfy 0 < flag < hold < block <= scoring.max_score")
	}
	if t.BlockMinCategories < 1 {
		add("thresholds.block_min_categories must be >= 1")
	}
	switch t.SingleCategoryCap {
	case "allow", "flag", "hold", "block":
	default:
		add("thresholds.single_category_cap must be an action, got %q", t.SingleCategoryCap)
	}
	for _, cat := range t.SingleCategoryExempt {
		if _, ok := knownSignals[cat]; !ok {
			add("thresholds.single_category_exempt: unknown category %q", cat)
		}
	}

	sections := map[string]map[string]int{
		"network":  c.Network.Points,
		"velocity": c.Velocity.Points,
		"content":  c.Content.Points,
		"account":  c.Account.Points,
	}
	for section, points := range sections {
		for name, p := range points {
			if !slices.Contains(knownSignals[section], name) {
				add("%s.points: unknown signal %q", section, name)
			}
			if p < 0 {
				add("%s.points.%s must be >= 0", section, name)
			}
		}
		for _, name := range knownSignals[section] {
			if _, ok := points[name]; !ok {
				add("%s.points.%s is missing", section, name)
			}
		}
	}

	if c.Baseline.MinEvents < 0 || c.Baseline.MaxKnownDomains < 1 {
		add("baseline: min_events must be >= 0 and max_known_domains >= 1")
	}
	if c.Velocity.Window <= 0 || c.Account.Window <= 0 {
		add("velocity.window and account.window must be > 0")
	}
	if c.Velocity.EWMAAlpha <= 0 || c.Velocity.EWMAAlpha > 1 {
		add("velocity.ewma_alpha must be in (0, 1]")
	}
	if c.Velocity.Multiplier <= 0 {
		add("velocity.multiplier must be > 0")
	}
	if c.Content.LookalikeMinLen < 1 || c.Content.LookalikeMaxDistance < 0 {
		add("content: lookalike_min_len must be >= 1 and lookalike_max_distance >= 0")
	}
	if c.Hold.TTL <= 0 || c.Hold.Tick <= 0 {
		add("hold.ttl and hold.tick must be > 0")
	}
	if c.Hold.ExpireAction != "drop" && c.Hold.ExpireAction != "release" {
		add("hold.expire_action must be drop or release, got %q", c.Hold.ExpireAction)
	}
	return errors.Join(errs...)
}

// Points returns the configured points for a hit name, searching all sections.
func (c *Config) Points(name string) int {
	for _, m := range []map[string]int{c.Network.Points, c.Velocity.Points, c.Content.Points, c.Account.Points} {
		if p, ok := m[name]; ok {
			return p
		}
	}
	return 0
}
