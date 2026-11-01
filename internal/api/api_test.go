package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testIngestToken  = "test-ingest-token"
	testAnalystToken = "test-analyst-token"
	testDecisionID   = "00000000-0000-0000-0000-000000000001"
)

func request(t *testing.T, handler http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if s, ok := body.(string); ok {
		raw = []byte(s)
	} else if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(raw))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func requireStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("HTTP %d, want %d: %s", w.Code, status, w.Body.String())
	}
	if status >= 400 {
		var response map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response["error"] == "" {
			t.Fatalf("expected JSON error, got %s", w.Body.String())
		}
	}
}

func decodeResponse[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	requireStatus(t, w, http.StatusOK)
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestRouteAuthentication(t *testing.T) {
	handler := (&Server{IngestToken: testIngestToken, AnalystToken: testAnalystToken}).Routes()
	routes := []struct{ name, method, path, otherToken string }{
		{
			name:       "event ingestion",
			method:     "POST",
			path:       "/v1/events",
			otherToken: testAnalystToken,
		},
		{
			name:       "dashboard",
			method:     "GET",
			path:       "/v1/dashboard",
			otherToken: testIngestToken,
		},
		{
			name:       "global audit feed",
			method:     "GET",
			path:       "/v1/analyst-actions",
			otherToken: testIngestToken,
		},
		{
			name:       "statistics",
			method:     "GET",
			path:       "/v1/stats",
			otherToken: testIngestToken,
		},
		{
			name:       "engine config",
			method:     "GET",
			path:       "/v1/config",
			otherToken: testIngestToken,
		},
		{
			name:       "account resolution",
			method:     "POST",
			path:       "/v1/accounts/acc/resolve",
			otherToken: testIngestToken,
		},
		{
			name:       "accounts",
			method:     "GET",
			path:       "/v1/accounts",
			otherToken: testIngestToken,
		},
		{
			name:       "timeline",
			method:     "GET",
			path:       "/v1/accounts/account/timeline",
			otherToken: testIngestToken,
		},
		{
			name:       "series",
			method:     "GET",
			path:       "/v1/accounts/account/series",
			otherToken: testIngestToken,
		},
		{
			name:       "profile",
			method:     "GET",
			path:       "/v1/accounts/account/profile",
			otherToken: testIngestToken,
		},
		{
			name:       "decision",
			method:     "GET",
			path:       "/v1/decisions/" + testDecisionID,
			otherToken: testIngestToken,
		},
		{
			name:       "analyst actions",
			method:     "POST",
			path:       "/v1/decisions/" + testDecisionID + "/actions",
			otherToken: testIngestToken,
		},
		{
			name:       "restore key",
			method:     "POST",
			path:       "/v1/keys/key/unblock",
			otherToken: testIngestToken,
		},
		{
			name:       "owner response",
			method:     "POST",
			path:       "/v1/holds/" + testDecisionID + "/owner-response",
			otherToken: testIngestToken,
		},
	}
	for _, route := range routes {
		t.Run(route.name, func(t *testing.T) {
			tokens := []struct{ name, value string }{
				{
					name:  "missing token",
					value: "",
				},
				{
					name:  "invalid token",
					value: "wrong",
				},
				{
					name:  "token for the other role",
					value: route.otherToken,
				},
			}
			for _, token := range tokens {
				t.Run(token.name, func(t *testing.T) {
					requireStatus(t, request(t, handler, route.method, route.path, token.value, nil), http.StatusUnauthorized)
				})
			}
		})
	}
}

func TestRequestValidation(t *testing.T) {
	handler := (&Server{IngestToken: testIngestToken, AnalystToken: testAnalystToken}).Routes()
	actionPath := "/v1/decisions/" + testDecisionID + "/actions"
	ownerPath := "/v1/holds/" + testDecisionID + "/owner-response"
	tests := []struct {
		name, method, path, token, body string
		wantStatus                      int
	}{
		{
			name:       "event JSON",
			method:     "POST",
			path:       "/v1/events",
			token:      testIngestToken,
			body:       "{",
			wantStatus: 400,
		},
		{
			name:       "event required fields",
			method:     "POST",
			path:       "/v1/events",
			token:      testIngestToken,
			body:       "{}",
			wantStatus: 400,
		},
		{
			name:       "event size",
			method:     "POST",
			path:       "/v1/events",
			token:      testIngestToken,
			body:       `{"padding":"` + strings.Repeat("x", maxEventBytes) + `"}`,
			wantStatus: 413,
		},
		{
			name:       "from",
			method:     "GET",
			path:       "/v1/stats?from=bad",
			token:      testAnalystToken,
			body:       "",
			wantStatus: 400,
		},
		{
			name:       "to",
			method:     "GET",
			path:       "/v1/accounts/account/series?to=bad",
			token:      testAnalystToken,
			body:       "",
			wantStatus: 400,
		},
		{
			name:       "bucket",
			method:     "GET",
			path:       "/v1/stats?bucket=1m",
			token:      testAnalystToken,
			body:       "",
			wantStatus: 400,
		},
		{
			name:       "zero limit",
			method:     "GET",
			path:       "/v1/accounts/account/timeline?limit=0",
			token:      testAnalystToken,
			body:       "",
			wantStatus: 400,
		},
		{
			name:       "large limit",
			method:     "GET",
			path:       "/v1/accounts/account/timeline?limit=5001",
			token:      testAnalystToken,
			body:       "",
			wantStatus: 400,
		},
		{
			name:       "noninteger limit",
			method:     "GET",
			path:       "/v1/accounts/account/timeline?limit=x",
			token:      testAnalystToken,
			body:       "",
			wantStatus: 400,
		},
		{
			name:       "decision ID",
			method:     "GET",
			path:       "/v1/decisions/invalid",
			token:      testAnalystToken,
			body:       "",
			wantStatus: 404,
		},
		{
			name:       "action ID",
			method:     "POST",
			path:       "/v1/decisions/invalid/actions",
			token:      testAnalystToken,
			body:       "{}",
			wantStatus: 404,
		},
		{
			name:       "owner ID",
			method:     "POST",
			path:       "/v1/holds/invalid/owner-response",
			token:      testAnalystToken,
			body:       "{}",
			wantStatus: 404,
		},
		{
			name:       "action JSON",
			method:     "POST",
			path:       actionPath,
			token:      testAnalystToken,
			body:       "{",
			wantStatus: 400,
		},
		{
			name:       "action name",
			method:     "POST",
			path:       actionPath,
			token:      testAnalystToken,
			body:       `{"action":"unknown","actor":"analyst","reason":"review"}`,
			wantStatus: 400,
		},
		{
			name:       "action actor",
			method:     "POST",
			path:       actionPath,
			token:      testAnalystToken,
			body:       `{"action":"release_hold","actor":"  ","reason":"review"}`,
			wantStatus: 400,
		},
		{
			name:       "action reason",
			method:     "POST",
			path:       actionPath,
			token:      testAnalystToken,
			body:       `{"action":"release_hold","actor":"analyst"}`,
			wantStatus: 400,
		},
		{
			name:       "unblock reason",
			method:     "POST",
			path:       "/v1/keys/key/unblock",
			token:      testAnalystToken,
			body:       `{"actor":"analyst","reason":" "}`,
			wantStatus: 400,
		},
		{
			name:       "owner response",
			method:     "POST",
			path:       ownerPath,
			token:      testAnalystToken,
			body:       `{"response":"maybe"}`,
			wantStatus: 400,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requireStatus(t, request(t, handler, tt.method, tt.path, tt.token, tt.body), tt.wantStatus)
		})
	}
}
