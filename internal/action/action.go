// Package action defines the four decision actions and their severity order,
// for Go code and for SQL that ranks the action column.
package action

import "slices"

// Action is what the engine decides for an event. Higher is more severe.
type Action int

const (
	Allow Action = iota
	Flag
	Hold
	Block
)

var names = []string{"allow", "flag", "hold", "block"}

// SeveritySQL is the actions as a Postgres array, least severe first:
// array_position(SeveritySQL, action) ranks an action column the way Action does.
const SeveritySQL = `array['allow','flag','hold','block']`

func (a Action) String() string { return names[a] }

// Parse returns the Action named s. An unknown name returns Allow and false.
func Parse(s string) (Action, bool) {
	i := slices.Index(names, s)
	return Action(max(i, 0)), i >= 0
}
