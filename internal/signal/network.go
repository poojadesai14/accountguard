package signal

import (
	"fmt"
	"strings"
)

// evalNetwork: is this key sending from an ASN it has never used? (history)
func evalNetwork(in *Input) []Hit {
	ev := in.Event
	if ev.APIKeyID == "" || in.Profile.ColdStart(in.Config) {
		return nil
	}
	known, scope := in.Profile.KnownASN(ev.APIKeyID, ev.Network.ASN, in.Config)
	if known {
		return nil
	}
	name := strings.TrimSpace(fmt.Sprintf("AS%d %s", ev.Network.ASN, ev.Network.ASNOrg))
	return hit(in, "new_asn", CatNetwork, fmt.Sprintf("%s first seen for %s", name, scope))
}
