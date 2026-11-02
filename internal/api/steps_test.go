package api

import (
	"context"
	"net/http/httptest"
	"testing"
)

// step is one row of an ordered, table-driven journey: a request, the status it
// must return, and what must hold afterwards. Steps share one fixture, so each
// runs only if the ones before it passed.
type step struct {
	name  string
	setup func(t *testing.T) // optional, before the request
	path  string             // empty: no request, only check
	body  any                // nil: GET; otherwise POST; a func() any is called when the step runs
	want  int                // expected HTTP status
	check func(t *testing.T, w *httptest.ResponseRecorder)
}

func runSteps(t *testing.T, f *apiFixture, steps []step) {
	t.Helper()
	for _, s := range steps {
		passed := t.Run(s.name, func(t *testing.T) {
			if s.setup != nil {
				s.setup(t)
			}
			var w *httptest.ResponseRecorder
			if s.path != "" {
				body := s.body
				if lazy, ok := body.(func() any); ok {
					body = lazy() // built from what earlier steps created
				}
				method := "GET"
				if body != nil {
					method = "POST"
				}
				w = request(t, f.handler, method, s.path, testAnalystToken, body)
				requireStatus(t, w, s.want)
			}
			if s.check != nil {
				s.check(t, w)
			}
		})
		if !passed {
			t.FailNow() // later steps depend on this one
		}
	}
}

// queryText runs a one-value query and returns it as text.
func queryText(t *testing.T, f *apiFixture, sql string, args ...any) string {
	t.Helper()
	var v string
	if err := f.server.Store.Pool.QueryRow(context.Background(), sql, args...).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// execSQL runs a statement as test setup.
func execSQL(t *testing.T, f *apiFixture, sql string, args ...any) {
	t.Helper()
	if _, err := f.server.Store.Pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

// wantText fails when a query's text result isn't want.
func wantText(t *testing.T, f *apiFixture, what, want, sql string, args ...any) {
	t.Helper()
	if got := queryText(t, f, sql, args...); got != want {
		t.Errorf("%s = %q, want %q", what, got, want)
	}
}
