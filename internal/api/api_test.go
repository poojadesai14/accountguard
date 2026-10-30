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
	routes := []struct{ method, path, otherToken string }{
		{"POST", "/v1/events", testAnalystToken},
		{"GET", "/v1/stats", testIngestToken},
		{"GET", "/v1/accounts", testIngestToken},
		{"GET", "/v1/accounts/account/timeline", testIngestToken},
		{"GET", "/v1/accounts/account/series", testIngestToken},
		{"GET", "/v1/accounts/account/profile", testIngestToken},
		{"GET", "/v1/decisions/" + testDecisionID, testIngestToken},
		{"POST", "/v1/decisions/" + testDecisionID + "/actions", testIngestToken},
		{"POST", "/v1/keys/key/unblock", testIngestToken},
		{"POST", "/v1/holds/" + testDecisionID + "/owner-response", testIngestToken},
	}
	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			for _, token := range []string{"", "wrong", route.otherToken} {
				requireStatus(t, request(t, handler, route.method, route.path, token, nil), http.StatusUnauthorized)
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
		status                          int
	}{
		{"event JSON", "POST", "/v1/events", testIngestToken, "{", 400},
		{"event required fields", "POST", "/v1/events", testIngestToken, "{}", 400},
		{"event size", "POST", "/v1/events", testIngestToken, `{"padding":"` + strings.Repeat("x", maxEventBytes) + `"}`, 413},
		{"from", "GET", "/v1/stats?from=bad", testAnalystToken, "", 400},
		{"to", "GET", "/v1/accounts/account/series?to=bad", testAnalystToken, "", 400},
		{"bucket", "GET", "/v1/stats?bucket=1m", testAnalystToken, "", 400},
		{"zero limit", "GET", "/v1/accounts/account/timeline?limit=0", testAnalystToken, "", 400},
		{"large limit", "GET", "/v1/accounts/account/timeline?limit=5001", testAnalystToken, "", 400},
		{"noninteger limit", "GET", "/v1/accounts/account/timeline?limit=x", testAnalystToken, "", 400},
		{"decision ID", "GET", "/v1/decisions/invalid", testAnalystToken, "", 404},
		{"action ID", "POST", "/v1/decisions/invalid/actions", testAnalystToken, "{}", 404},
		{"owner ID", "POST", "/v1/holds/invalid/owner-response", testAnalystToken, "{}", 404},
		{"action JSON", "POST", actionPath, testAnalystToken, "{", 400},
		{"action name", "POST", actionPath, testAnalystToken, `{"action":"unknown","actor":"analyst","reason":"review"}`, 400},
		{"action actor", "POST", actionPath, testAnalystToken, `{"action":"release_hold","actor":"  ","reason":"review"}`, 400},
		{"action reason", "POST", actionPath, testAnalystToken, `{"action":"release_hold","actor":"analyst"}`, 400},
		{"unblock reason", "POST", "/v1/keys/key/unblock", testAnalystToken, `{"actor":"analyst","reason":" "}`, 400},
		{"owner response", "POST", ownerPath, testAnalystToken, `{"response":"maybe"}`, 400},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requireStatus(t, request(t, handler, tt.method, tt.path, tt.token, tt.body), tt.status)
		})
	}
}
