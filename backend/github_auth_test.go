package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// fakeGitHubOAuth serves the three GitHub endpoints the login flow uses.
func fakeGitHubOAuth(t *testing.T, wantCode string) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		if r.Form.Get("code") != wantCode || r.Form.Get("client_secret") != "sekret" || r.Form.Get("client_id") != "cid" {
			_, _ = w.Write([]byte(`{"error":"bad_verification_code"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"gho_test","token_type":"bearer"}`))
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gho_test" {
			w.WriteHeader(401)
			return
		}
		_, _ = w.Write([]byte(`{"id":4242,"login":"octocat"}`))
	})
	mux.HandleFunc("GET /user/emails", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"email":"unverified@x.io","primary":false,"verified":false},{"email":"Octo@Example.com","primary":true,"verified":true}]`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	t.Setenv("GITHUB_OAUTH_URL", srv.URL)
	t.Setenv("GITHUB_API_URL", srv.URL)
}

func ghTestAPI(t *testing.T) *API {
	api, _, _ := newTestAPI(t)
	api.cfg.GitHubClientID = "cid"
	api.cfg.GitHubClientSecret = "sekret"
	api.cfg.JWTSecret = "test-secret"
	api.cfg.FrontendURL = "http://localhost:3000"
	return api
}

// startLogin hits /github/login and returns the state sent to GitHub plus the cookies to replay on the callback.
func startLogin(t *testing.T, api *API, client string) (state string, cookies []*http.Cookie) {
	t.Helper()
	rec := httptest.NewRecorder()
	api.routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/github/login?client="+client, nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("login: want 302, got %d: %s", rec.Code, rec.Body.String())
	}
	loc, _ := url.Parse(rec.Header().Get("Location"))
	q := loc.Query()
	if q.Get("client_id") != "cid" || q.Get("scope") != "read:user user:email" ||
		q.Get("redirect_uri") != "http://localhost:8080/api/auth/github/callback" || q.Get("state") == "" {
		t.Fatalf("bad authorize URL: %s", loc)
	}
	return q.Get("state"), rec.Result().Cookies()
}

func callback(api *API, state, code string, cookies []*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", "/api/auth/github/callback?code="+code+"&state="+url.QueryEscape(state), nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	api.routes().ServeHTTP(rec, req)
	return rec
}

func TestGitHubLoginWebFlowAndMe(t *testing.T) {
	fakeGitHubOAuth(t, "good-code")
	api := ghTestAPI(t)
	state, cookies := startLogin(t, api, "web")

	rec := callback(api, state, "good-code", cookies)
	if rec.Code != http.StatusFound {
		t.Fatalf("callback: want 302, got %d: %s", rec.Code, rec.Body.String())
	}
	loc, _ := url.Parse(rec.Header().Get("Location"))
	if loc.Host != "localhost:3000" {
		t.Fatalf("redirected to %s", loc)
	}
	frag, _ := url.ParseQuery(loc.Fragment)
	token := frag.Get("github_token")
	if token == "" {
		t.Fatalf("no github_token in %q", loc.Fragment)
	}
	claims, err := VerifyToken(token, "test-secret")
	if err != nil || claims.Login != "octocat" || claims.UserID != 4242 || claims.Email != "octo@example.com" {
		t.Fatalf("bad claims %+v err=%v", claims, err)
	}

	// /api/auth/me resolves the stateless GitHub token without a database.
	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	me := httptest.NewRecorder()
	api.routes().ServeHTTP(me, req)
	var u User
	if me.Code != 200 || json.Unmarshal(me.Body.Bytes(), &u) != nil || u.GitHubLogin != "octocat" || u.Email != "octo@example.com" {
		t.Fatalf("me: %d %s", me.Code, me.Body.String())
	}
}

func TestGitHubLoginVSCodeReturnsURIPage(t *testing.T) {
	fakeGitHubOAuth(t, "c")
	api := ghTestAPI(t)
	state, cookies := startLogin(t, api, "vscode")
	rec := callback(api, state, "c", cookies)
	body := rec.Body.String()
	if rec.Code != 200 || !strings.Contains(body, "vscode://depexit.depexit/auth?token=") ||
		!strings.Contains(rec.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("want HTML page with vscode:// link, got %d %s", rec.Code, body)
	}
}

func TestGitHubLoginRejections(t *testing.T) {
	fakeGitHubOAuth(t, "good")
	api := ghTestAPI(t)
	state, cookies := startLogin(t, api, "web")

	errOf := func(rec *httptest.ResponseRecorder) string {
		loc, _ := url.Parse(rec.Header().Get("Location"))
		f, _ := url.ParseQuery(loc.Fragment)
		return f.Get("github_error")
	}
	// wrong code at GitHub
	if e := errOf(callback(api, state, "nope", cookies)); !strings.Contains(e, "bad_verification_code") {
		t.Errorf("bad code: got %q", e)
	}
	// missing cookie (login started in a different browser)
	if e := errOf(callback(api, state, "good", nil)); !strings.Contains(e, "mismatch") {
		t.Errorf("no cookie: got %q", e)
	}
	// tampered / forged state
	if e := errOf(callback(api, state+"x", "good", cookies)); e != "invalid state" {
		t.Errorf("forged state: got %q", e)
	}
	// expired state
	old := signOAuthState("test-secret", oauthState{Nonce: "n", Client: "web", Exp: time.Now().Add(-time.Minute).Unix()})
	if e := errOf(callback(api, old, "good", cookies)); !strings.Contains(e, "expired") {
		t.Errorf("expired: got %q", e)
	}
	// state signed with another secret
	other := signOAuthState("other", oauthState{Nonce: "n", Client: "web", Exp: time.Now().Add(time.Minute).Unix()})
	if e := errOf(callback(api, other, "good", cookies)); e != "invalid state" {
		t.Errorf("wrong secret: got %q", e)
	}
	// user denied access on GitHub
	req := httptest.NewRequest("GET", "/api/auth/github/callback?error=access_denied&state="+url.QueryEscape(state), nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	api.routes().ServeHTTP(rec, req)
	if e := errOf(rec); !strings.Contains(e, "access_denied") {
		t.Errorf("denied: got %q", e)
	}
	// unknown client value
	bad := httptest.NewRecorder()
	api.routes().ServeHTTP(bad, httptest.NewRequest("GET", "/api/auth/github/login?client=javascript", nil))
	if bad.Code != 400 {
		t.Errorf("unknown client: want 400, got %d", bad.Code)
	}
}

func TestGitHubProvidersAndUnconfigured(t *testing.T) {
	api, _, _ := newTestAPI(t)
	rec := httptest.NewRecorder()
	api.routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/providers", nil))
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"github":false}` {
		t.Fatalf("providers: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	api.routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/github/login", nil))
	loc, _ := url.Parse(rec.Header().Get("Location"))
	f, _ := url.ParseQuery(loc.Fragment)
	if rec.Code != 302 || !strings.Contains(f.Get("github_error"), "not configured") {
		t.Fatalf("unconfigured: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	api2 := ghTestAPI(t)
	rec = httptest.NewRecorder()
	api2.routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/providers", nil))
	if strings.TrimSpace(rec.Body.String()) != `{"github":true}` {
		t.Fatalf("providers (configured): %s", rec.Body.String())
	}
}

func TestStateRoundTrip(t *testing.T) {
	s := signOAuthState("k", oauthState{Nonce: "abc", Client: "vscode", Exp: time.Now().Add(time.Minute).Unix()})
	got, err := parseOAuthState("k", s)
	if err != nil || got.Nonce != "abc" || got.Client != "vscode" {
		t.Fatalf("%+v %v", got, err)
	}
}
