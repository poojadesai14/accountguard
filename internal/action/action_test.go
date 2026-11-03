package action

import (
	"strings"
	"testing"
)

func TestSeveritySQLMatchesOrder(t *testing.T) {
	want := "array['" + strings.Join(names, "','") + "']"
	if SeveritySQL != want {
		t.Errorf("SeveritySQL = %s, want %s", SeveritySQL, want)
	}
}

func TestParse(t *testing.T) {
	tests := []struct {
		in     string
		want   Action
		wantOK bool
	}{
		{in: "allow", want: Allow, wantOK: true},
		{in: "flag", want: Flag, wantOK: true},
		{in: "hold", want: Hold, wantOK: true},
		{in: "block", want: Block, wantOK: true},
		{in: "", want: Allow, wantOK: false},
		{in: "quarantine", want: Allow, wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, ok := Parse(tt.in)
			if got != tt.want || ok != tt.wantOK {
				t.Errorf("Parse(%q) = %v, %v; want %v, %v", tt.in, got, ok, tt.want, tt.wantOK)
			}
			if ok && got.String() != tt.in {
				t.Errorf("String() = %q, want %q", got.String(), tt.in)
			}
		})
	}
}
