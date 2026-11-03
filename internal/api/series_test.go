package api

import (
	"reflect"
	"testing"
	"time"

	"github.com/poojadesai14/resend-ato/internal/event"
	"github.com/poojadesai14/resend-ato/internal/signal"
	"github.com/poojadesai14/resend-ato/internal/store"
)

func TestSeriesPoints(t *testing.T) {
	t0 := time.Date(2026, 10, 30, 9, 0, 0, 0, time.UTC)
	asn := func(n int) *int { return &n }
	send := func(at time.Time, recipients int, network int, firstSeen time.Time, action string, hits ...signal.Hit) store.SeriesEvent {
		return store.SeriesEvent{OccurredAt: at, Type: event.TypeEmailSend, RecipientCount: recipients, ASN: asn(network),
			ASNOrg: "ISP", ASNFirstSeen: firstSeen, Action: action, Hits: hits}
	}
	point := func(at time.Time) seriesPoint {
		return seriesPoint{T: at, ASNs: []seriesASN{}, ContentHits: []string{}, Actions: map[string]int{}}
	}

	tests := []struct {
		name string
		evs  []store.SeriesEvent
		want func() []seriesPoint
	}{
		{
			name: "no events is an empty list, not null",
			want: func() []seriesPoint { return []seriesPoint{} },
		},
		{
			name: "events in one hour share a point; recipients and actions add up",
			evs: []store.SeriesEvent{
				send(t0.Add(5*time.Minute), 10, 1, t0.AddDate(0, 0, -30), "allow"),
				send(t0.Add(50*time.Minute), 5, 1, t0.AddDate(0, 0, -30), "allow"),
				{OccurredAt: t0.Add(55 * time.Minute), Type: event.TypeAccountChange, Action: "flag"},
			},
			want: func() []seriesPoint {
				p := point(t0)
				p.Recipients, p.AccountChanges = 15, 1
				p.ASNs = []seriesASN{{ASN: 1, Org: "ISP", FirstSeen: false}}
				p.Actions = map[string]int{"allow": 2, "flag": 1}
				return []seriesPoint{p}
			},
		},
		{
			name: "an ASN is first seen only in the hour the account first used it",
			evs: []store.SeriesEvent{
				send(t0.Add(10*time.Minute), 1, 2, t0.Add(10*time.Minute), "hold"),
				send(t0.Add(70*time.Minute), 1, 2, t0.Add(10*time.Minute), "hold"),
			},
			want: func() []seriesPoint {
				first, later := point(t0), point(t0.Add(time.Hour))
				first.Recipients, later.Recipients = 1, 1
				first.ASNs = []seriesASN{{ASN: 2, Org: "ISP", FirstSeen: true}}
				later.ASNs = []seriesASN{{ASN: 2, Org: "ISP", FirstSeen: false}}
				first.Actions, later.Actions = map[string]int{"hold": 1}, map[string]int{"hold": 1}
				return []seriesPoint{first, later}
			},
		},
		{
			name: "content hits are listed once per hour; other categories and unscored events are left out",
			evs: []store.SeriesEvent{
				send(t0, 1, 1, t0, "hold",
					signal.Hit{Name: "young_domain", Category: signal.CatContent},
					signal.Hit{Name: "new_asn", Category: signal.CatNetwork}),
				send(t0.Add(time.Minute), 1, 1, t0, "",
					signal.Hit{Name: "young_domain", Category: signal.CatContent},
					signal.Hit{Name: "lookalike_domain", Category: signal.CatContent}),
			},
			want: func() []seriesPoint {
				p := point(t0)
				p.Recipients = 2
				p.ASNs = []seriesASN{{ASN: 1, Org: "ISP", FirstSeen: true}}
				p.ContentHits = []string{"young_domain", "lookalike_domain"}
				p.Actions = map[string]int{"hold": 1}
				return []seriesPoint{p}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, want := seriesPoints(tt.evs), tt.want()
			if !reflect.DeepEqual(got, want) {
				t.Errorf("seriesPoints =\n%+v\nwant\n%+v", got, want)
			}
		})
	}
}
