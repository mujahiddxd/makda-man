package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// "Sign in with GitHub" (OAuth web flow). Identity only: scopes are read:user + user:email, and the GitHub access
// token is used once to read the profile and is never stored or returned.
//
//	GET /api/auth/providers            -> {"github": true|false}
//	GET /api/auth/github/login         -> 302 to GitHub (?client=web|vscode|vscode-insiders|vscodium|cursor)
//	GET /api/auth/github/callback      -> exchanges the code, then hands the DepExit JWT back to the client:
//	                                       web    -> 302 {FRONTEND_URL}/#github_token=<jwt>   (or #github_error=<msg>)
//	                                       vscode -> small HTML page that opens <scheme>://depexit.depexit/auth?token=<jwt>

const (
	oauthStateCookie = "depexit_oauth_state"
	oauthStateTTL    = 10 * time.Minute
	githubScopes     = "read:user user:email"
	// VS Code extension id (publisher.name) used for the vscode:// URI handler.
	vscodeExtensionID = "depexit.depexit"
)

var allowedOAuthClients = map[string]bool{"web": true, "vscode": true, "vscode-insiders": true, "vscodium": true, "cursor": true}

// githubOAuthBase is overridable so tests can point it at a fake GitHub.
func githubOAuthBase() string {
	if v := strings.TrimRight(os.Getenv("GITHUB_OAUTH_URL"), "/"); v != "" {
		return v
	}
	return "https://github.com"
}

func (a *API) githubConfigured() bool {
	return a.cfg.GitHubClientID != "" && a.cfg.GitHubClientSecret != ""
}

func (a *API) githubRedirectURI() string {
	if a.cfg.GitHubRedirectURI != "" {
		return a.cfg.GitHubRedirectURI
	}
	port := a.cfg.Port
	if port == "" {
		port = "8080"
	}
	return "http://localhost:" + port + "/api/auth/github/callback"
}

func (a *API) frontendURL() string {
	if a.cfg.FrontendURL != "" {
		return strings.TrimRight(a.cfg.FrontendURL, "/")
	}
	return "http://localhost:3000"
}

// ---- signed, short-lived OAuth state ----

type oauthState struct {
	Nonce  string `json:"n"`
	Client string `json:"c"`
	Exp    int64  `json:"e"`
}

func stateMAC(secret, payload string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte("github-oauth-state." + payload))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

func signOAuthState(secret string, s oauthState) string {
	b, _ := json.Marshal(s)
	p := base64.RawURLEncoding.EncodeToString(b)
	return p + "." + stateMAC(secret, p)
}

func parseOAuthState(secret, v string) (oauthState, error) {
	var s oauthState
	p, sig, ok := strings.Cut(v, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(stateMAC(secret, p))) {
		return s, errors.New("invalid state")
	}
	b, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil || json.Unmarshal(b, &s) != nil {
		return s, errors.New("invalid state")
	}
	if s.Exp < time.Now().Unix() {
		return s, errors.New("login attempt expired, please try again")
	}
	return s, nil
}

// ---- handlers ----

func (a *API) authProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"github": a.githubConfigured()})
}

func (a *API) githubLogin(w http.ResponseWriter, r *http.Request) {
	client := r.URL.Query().Get("client")
	if client == "" {
		client = "web"
	}
	if !allowedOAuthClients[client] {
		writeErr(w, http.StatusBadRequest, "bad_request", "unknown client")
		return
	}
	if !a.githubConfigured() {
		a.githubFinish(w, r, client, "", "GitHub login is not configured on the server (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env)")
		return
	}
	nb := make([]byte, 16)
	if _, err := rand.Read(nb); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "could not start login")
		return
	}
	nonce := hex.EncodeToString(nb)
	state := signOAuthState(a.cfg.JWTSecret, oauthState{Nonce: nonce, Client: client, Exp: time.Now().Add(oauthStateTTL).Unix()})
	http.SetCookie(w, &http.Cookie{
		Name: oauthStateCookie, Value: nonce, Path: "/api/auth/github", MaxAge: int(oauthStateTTL.Seconds()),
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(a.githubRedirectURI(), "https://"),
	})
	q := url.Values{}
	q.Set("client_id", a.cfg.GitHubClientID)
	q.Set("redirect_uri", a.githubRedirectURI())
	q.Set("scope", githubScopes)
	q.Set("state", state)
	q.Set("allow_signup", "true")
	http.Redirect(w, r, githubOAuthBase()+"/login/oauth/authorize?"+q.Encode(), http.StatusFound)
}

func (a *API) githubCallback(w http.ResponseWriter, r *http.Request) {
	// Until the state is verified we do not know which client started the flow, so early errors go to the web UI.
	st, err := parseOAuthState(a.cfg.JWTSecret, r.URL.Query().Get("state"))
	if err != nil {
		a.githubFinish(w, r, "web", "", err.Error())
		return
	}
	// Clear the one-time cookie whatever happens next.
	http.SetCookie(w, &http.Cookie{Name: oauthStateCookie, Value: "", Path: "/api/auth/github", MaxAge: -1, HttpOnly: true})
	ck, cerr := r.Cookie(oauthStateCookie)
	if cerr != nil || !hmac.Equal([]byte(ck.Value), []byte(st.Nonce)) {
		a.githubFinish(w, r, st.Client, "", "login session mismatch, please start again from the same browser")
		return
	}
	if e := r.URL.Query().Get("error"); e != "" {
		msg := r.URL.Query().Get("error_description")
		if msg == "" {
			msg = e
		}
		a.githubFinish(w, r, st.Client, "", "GitHub: "+msg)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		a.githubFinish(w, r, st.Client, "", "GitHub did not return a code")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	ghTok, err := a.githubExchange(ctx, code)
	if err != nil {
		log.Printf("github login: token exchange failed: %v", err)
		a.githubFinish(w, r, st.Client, "", "GitHub rejected the login ("+err.Error()+")")
		return
	}
	gu, err := fetchGitHubUser(ctx, ghTok)
	if err != nil {
		log.Printf("github login: profile fetch failed: %v", err)
		a.githubFinish(w, r, st.Client, "", "could not read your GitHub profile")
		return
	}
	user, err := a.upsertGitHubUser(ctx, gu)
	if err != nil {
		log.Printf("github login: user upsert failed: %v", err)
		a.githubFinish(w, r, st.Client, "", "could not create your DepExit account")
		return
	}
	token, err := GenerateTokenWithLogin(user.ID, user.Email, user.GitHubLogin, a.cfg.JWTSecret)
	if err != nil {
		a.githubFinish(w, r, st.Client, "", "could not create a session")
		return
	}
	a.githubFinish(w, r, st.Client, token, "")
}

// githubFinish returns the result (a DepExit JWT or an error message) to whichever client started the login.
func (a *API) githubFinish(w http.ResponseWriter, r *http.Request, client, token, errMsg string) {
	if client == "web" || client == "" {
		frag := url.Values{}
		if errMsg != "" {
			frag.Set("github_error", errMsg)
		} else {
			frag.Set("github_token", token)
		}
		http.Redirect(w, r, a.frontendURL()+"/#"+frag.Encode(), http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if errMsg != "" {
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>DepExit sign-in</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h2>GitHub sign-in failed</h2><p>%s</p><p>Close this tab and try again from VS Code.</p></body>`, html.EscapeString(errMsg))
		return
	}
	target := client + "://" + vscodeExtensionID + "/auth?" + url.Values{"token": {token}}.Encode()
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>DepExit sign-in</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h2>Signed in with GitHub</h2>
<p>Returning to your editor&hellip; If nothing happens, <a href="%s">click here</a>. You can close this tab afterwards.</p>
<script>location.href=%q;</script></body>`, html.EscapeString(target), target)
}

// ---- GitHub API ----

type ghProfile struct {
	ID    int64
	Login string
	Email string // primary verified email, or a noreply address
}

func (a *API) githubExchange(ctx context.Context, code string) (string, error) {
	form := url.Values{}
	form.Set("client_id", a.cfg.GitHubClientID)
	form.Set("client_secret", a.cfg.GitHubClientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", a.githubRedirectURI())
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, githubOAuthBase()+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if out.AccessToken == "" {
		if out.Error != "" {
			return "", errors.New(out.Error)
		}
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return out.AccessToken, nil
}

func ghGet(ctx context.Context, token, path string, v any) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, githubAPIBase()+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(v)
}

func fetchGitHubUser(ctx context.Context, token string) (*ghProfile, error) {
	var u struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
	}
	if err := ghGet(ctx, token, "/user", &u); err != nil {
		return nil, err
	}
	if u.ID == 0 || u.Login == "" {
		return nil, errors.New("empty GitHub profile")
	}
	p := &ghProfile{ID: u.ID, Login: u.Login, Email: fmt.Sprintf("%d+%s@users.noreply.github.com", u.ID, u.Login)}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := ghGet(ctx, token, "/user/emails", &emails); err == nil { // best effort: needs user:email
		for _, e := range emails {
			if e.Verified && e.Primary {
				p.Email = strings.ToLower(e.Email)
				return p, nil
			}
		}
		for _, e := range emails {
			if e.Verified {
				p.Email = strings.ToLower(e.Email)
				return p, nil
			}
		}
	}
	return p, nil
}

// ---- user storage ----

// upsertGitHubUser finds or creates the DepExit user for a GitHub profile. Without a database the login is
// stateless: the JWT itself carries the identity (id = GitHub id).
func (a *API) upsertGitHubUser(ctx context.Context, p *ghProfile) (User, error) {
	if a.authDB == nil {
		return User{ID: int(p.ID), Email: p.Email, GitHubLogin: p.Login, CreatedAt: time.Now()}, nil
	}
	db := a.authDB.db
	var u User
	err := db.QueryRowContext(ctx, `SELECT id, email, created_at FROM users WHERE github_id = $1`, p.ID).
		Scan(&u.ID, &u.Email, &u.CreatedAt)
	switch {
	case err == nil:
		_, _ = db.ExecContext(ctx, `UPDATE users SET github_login = $2 WHERE id = $1`, u.ID, p.Login)
	case errors.Is(err, sql.ErrNoRows):
		// Never link to an existing password account by email: password sign-up does not verify the address, so
		// linking would let someone pre-register a victim's email and inherit their GitHub login. If the email is
		// taken, the GitHub account gets its own noreply address instead.
		err = db.QueryRowContext(ctx,
			`INSERT INTO users (email, password_hash, github_id, github_login) VALUES ($1, NULL, $2, $3)
			 ON CONFLICT (email) DO NOTHING RETURNING id, email, created_at`, p.Email, p.ID, p.Login).
			Scan(&u.ID, &u.Email, &u.CreatedAt)
		if errors.Is(err, sql.ErrNoRows) {
			err = db.QueryRowContext(ctx,
				`INSERT INTO users (email, password_hash, github_id, github_login) VALUES ($1, NULL, $2, $3)
				 RETURNING id, email, created_at`, fmt.Sprintf("%d+%s@users.noreply.github.com", p.ID, p.Login), p.ID, p.Login).
				Scan(&u.ID, &u.Email, &u.CreatedAt)
		}
		if err != nil {
			return User{}, err
		}
	default:
		return User{}, err
	}
	u.GitHubLogin = p.Login
	return u, nil
}
