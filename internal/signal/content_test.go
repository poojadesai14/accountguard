package signal

import "testing"

func TestLookalike(t *testing.T) {
	tests := []struct {
		candidate, brand string
		want             bool
	}{
		{"acrne.com", "acme.com", true},       // typo, distance 2
		{"acme-secure.com", "acme.com", true}, // contains brand
		{"myacme.net", "acme.com", true},
		{"acme.co", "acme.com", true}, // other suffix
		{"acme.co.uk", "acme.com", true},
		{"acme.com", "acme.com", false},
		{"ab.com", "ac.com", false}, // too short
		{"stripe.com", "acme.com", false},
		{"ac.com", "acme.com", false}, // candidate too short
		{"betta.io", "beta.io", true},
	}
	for _, tt := range tests {
		if got := Lookalike(tt.candidate, tt.brand, 2, 4); got != tt.want {
			t.Errorf("Lookalike(%s, %s) = %v, want %v", tt.candidate, tt.brand, got, tt.want)
		}
	}
}

func TestLevenshtein(t *testing.T) {
	for _, tt := range []struct {
		a, b string
		want int
	}{{"acme", "acme", 0}, {"acme", "acrne", 2}, {"", "abc", 3}, {"kitten", "sitting", 3}} {
		if got := levenshtein(tt.a, tt.b); got != tt.want {
			t.Errorf("levenshtein(%q,%q) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}
