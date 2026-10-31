package signal

import "testing"

func TestLookalike(t *testing.T) {
	tests := []struct {
		name, candidate, brand string
		want                   bool
	}{
		{
			name:      "two edit typo",
			candidate: "acrne.com",
			brand:     "acme.com",
			want:      true,
		},
		{
			name:      "brand with security suffix",
			candidate: "acme-secure.com",
			brand:     "acme.com",
			want:      true,
		},
		{
			name:      "brand inside another domain",
			candidate: "myacme.net",
			brand:     "acme.com",
			want:      true,
		},
		{
			name:      "different public suffix",
			candidate: "acme.co",
			brand:     "acme.com",
			want:      true,
		},
		{
			name:      "multi-part public suffix",
			candidate: "acme.co.uk",
			brand:     "acme.com",
			want:      true,
		},
		{
			name:      "exact brand is legitimate",
			candidate: "acme.com",
			brand:     "acme.com",
			want:      false,
		},
		{
			name:      "both names too short",
			candidate: "ab.com",
			brand:     "ac.com",
			want:      false,
		},
		{
			name:      "unrelated domain",
			candidate: "stripe.com",
			brand:     "acme.com",
			want:      false,
		},
		{
			name:      "candidate too short",
			candidate: "ac.com",
			brand:     "acme.com",
			want:      false,
		},
		{
			name:      "single extra character",
			candidate: "betta.io",
			brand:     "beta.io",
			want:      true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Lookalike(tt.candidate, tt.brand, 2, 4); got != tt.want {
				t.Errorf("Lookalike(%q, %q) = %v, want %v", tt.candidate, tt.brand, got, tt.want)
			}
		})
	}
}
func TestLevenshtein(t *testing.T) {
	tests := []struct {
		name, left, right string
		want              int
	}{
		{
			name:  "identical names",
			left:  "acme",
			right: "acme",
			want:  0,
		},
		{
			name:  "two edits",
			left:  "acme",
			right: "acrne",
			want:  2,
		},
		{
			name:  "empty left side",
			left:  "",
			right: "abc",
			want:  3,
		},
		{
			name:  "insertions and substitutions",
			left:  "kitten",
			right: "sitting",
			want:  3,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := levenshtein(tt.left, tt.right); got != tt.want {
				t.Errorf("levenshtein(%q, %q) = %d, want %d", tt.left, tt.right, got, tt.want)
			}
		})
	}
}
