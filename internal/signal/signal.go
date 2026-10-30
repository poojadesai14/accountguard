// Package signal holds the four detection signals. Each compares one event against the
// account's own baseline and returns zero or more hits. Adding a signal = appending to All.
package signal

import (
	"github.com/poojadesai14/resend-ato/internal/config"
	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/profile"
)

const (
	CatNetwork  = "network"
	CatVelocity = "velocity"
	CatContent  = "content"
	CatAccount  = "account"
)

type Hit struct {
	Name     string `json:"name"`
	Category string `json:"category"`
	Points   int    `json:"points"`
	Detail   string `json:"detail"`
}

// Input is everything a signal may look at. The profile is the state BEFORE this event.
type Input struct {
	Event            *event.Event
	Features         event.Features
	Profile          *profile.Profile
	WindowRecipients int // recipients sent by this account in the velocity window, including this event
	Config           *config.Config
}

// EvalFunc checks one event against the account's baseline and returns its hits.
type EvalFunc func(in *Input) []Hit

type Signal struct {
	Name     string
	Category string
	Eval     EvalFunc
}

var All = []Signal{
	{"network", CatNetwork, evalNetwork},
	{"velocity", CatVelocity, evalVelocity},
	{"content", CatContent, evalContent},
	{"account", CatAccount, evalAccount},
}

// hit builds a Hit with points from config. Signals configured at 0 points produce no hit.
func hit(in *Input, name, category, detail string) []Hit {
	p := in.Config.Points(name)
	if p <= 0 {
		return nil
	}
	return []Hit{{Name: name, Category: category, Points: p, Detail: detail}}
}
