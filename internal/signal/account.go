package signal

import (
	"fmt"
	"time"

	"github.com/poojadesai14/accountguard/internal/event"
)

// evalAccount: recent account changes (persistence) and first-ever recon reads. Needs no history.
func evalAccount(in *Input) []Hit {
	ev, p, cfg := in.Event, in.Profile, in.Config
	t := ev.OccurredAt
	within := func(ts *time.Time) bool {
		return ts != nil && !ts.After(t) && t.Sub(*ts) < cfg.Account.Window
	}

	var hits []Hit
	switch {
	case ev.Type == event.TypeAccountChange && ev.Change != nil:
		hits = append(hits, hit(in, "recent_account_change", CatAccount, "this event: "+ev.Change.Kind)...)
	case within(p.LastChangeAt):
		hits = append(hits, hit(in, "recent_account_change", CatAccount,
			fmt.Sprintf("account change %s before this event", t.Sub(*p.LastChangeAt).Round(time.Minute)))...)
	}

	// During onboarding every read is a first read, so young accounts are exempt.
	if t.Sub(p.FirstSeenAt) < cfg.Account.FirstReadMinAccountAge {
		return hits
	}
	switch {
	case p.IsFirstRead(ev, cfg):
		hits = append(hits, hit(in, "first_read", CatAccount, "first-ever read of "+ev.Read.Resource)...)
	case within(p.LastFirstReadAt):
		hits = append(hits, hit(in, "first_read", CatAccount,
			fmt.Sprintf("first-ever recon read %s before this event", t.Sub(*p.LastFirstReadAt).Round(time.Minute)))...)
	}
	return hits
}
