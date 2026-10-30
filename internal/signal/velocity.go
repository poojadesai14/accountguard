package signal

import (
	"fmt"

	"github.com/poojadesai14/resend-ato/internal/event"
)

// evalVelocity: are recipients in the window far above this account's normal hourly volume? (history)
// Weakest signal by design - a legitimate campaign looks the same - so it never acts alone.
func evalVelocity(in *Input) []Hit {
	cfg, p := in.Config.Velocity, in.Profile
	if in.Event.Type != event.TypeEmailSend || p.ColdStart(in.Config) || p.ActiveHours < cfg.MinActiveHours {
		return nil
	}
	normal := max(p.HourlyEWMA, cfg.MinHourlyBaseline)
	if float64(in.WindowRecipients) <= cfg.Multiplier*normal {
		return nil
	}
	return hit(in, "recipient_spike", CatVelocity, fmt.Sprintf(
		"%d recipients in the last %s vs normal %.0f/hour (%.1fx)",
		in.WindowRecipients, cfg.Window, normal, float64(in.WindowRecipients)/normal))
}
