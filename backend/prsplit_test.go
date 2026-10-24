package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeGitHubPush plays a repository the token CAN push to (stacked PRs live in it) and records PR requests.
type fakeGitHubPush struct {
	mu      sync.Mutex
	push    bool
	commits []map[string]any // POST git/commits bodies, in order
	refs    []map[string]any
	pulls   []map[string]any
	patched map[int]string // PR number -> body sent with PATCH
	blobs   []string
}

func (f *fakeGitHubPush) server(t *testing.T) string {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			w.WriteHeader(401)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		j := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch {
		case r.URL.Path == "/user":
			j(map[string]any{"login": "owner"})
		case r.Method == "GET" && r.URL.Path == "/repos/up/proj":
			j(map[string]any{"default_branch": "main", "permissions": map[string]any{"push": f.push}})
		case r.Method == "POST" && r.URL.Path == "/repos/up/proj/forks":
			w.WriteHeader(202)
			j(map[string]any{"full_name": "owner/proj", "owner": map[string]any{"login": "owner"}})
		case r.Method == "GET" && strings.Contains(r.URL.Path, "/git/commits/"):
			j(map[string]any{"tree": map[string]any{"sha": "tree-of-" + filepath.Base(r.URL.Path)}})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/blobs"):
			f.blobs = append(f.blobs, body["content"].(string))
			j(map[string]any{"sha": fmt.Sprintf("blob%d", len(f.blobs))})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/trees"):
			j(map[string]any{"sha": fmt.Sprintf("tree%d", len(f.commits)+1)})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/commits"):
			f.commits = append(f.commits, body)
			j(map[string]any{"sha": fmt.Sprintf("c%d", len(f.commits))})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/refs"):
			f.refs = append(f.refs, body)
			w.WriteHeader(201)
			j(map[string]any{})
		case r.Method == "POST" && r.URL.Path == "/repos/up/proj/pulls":
			n++
			f.pulls = append(f.pulls, body)
			w.WriteHeader(201)
			j(map[string]any{"html_url": fmt.Sprintf("https://github.com/up/proj/pull/%d", 10+n), "number": 10 + n})
		case r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/repos/up/proj/pulls/"):
			var num int
			fmt.Sscanf(filepath.Base(r.URL.Path), "%d", &num)
			f.patched[num] = body["body"].(string)
			j(map[string]any{})
		default:
			t.Errorf("unexpected call %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// setupSplitJob: the toml job from setupPRJob plus a 2-part split (quick win "six" + rewrite "toml").
func setupSplitJob(t *testing.T) (*API, string) {
	api, id := setupPRJob(t)
	dir := api.store.jobDir(id)
	writeFile(t, filepath.Join(dir, "repo", "requirements.txt"), "six==1.0\ntoml==0.10.2\n")
	writeFile(t, filepath.Join(dir, "runs", "migrated", "repo", "requirements.txt"), "")
	writeFile(t, filepath.Join(dir, "split", "1", "requirements.txt"), "toml==0.10.2\n")
	writeFile(t, filepath.Join(dir, "split", "2", "requirements.txt"), "")
	writeFile(t, filepath.Join(dir, "split.json"), `{"available": true, "reason": null,
	  "note": "Only the final state (all parts together) ran in the Docker sandbox.",
	  "groups": [
	    {"index": 1, "kind": "quick_wins", "dependencies": ["six"], "files": [{"path": "requirements.txt", "source": "split"}],
	     "insertions": 0, "deletions": 1, "label": "plan", "risk_reduction": 55, "title": "quick wins: remove six"},
	    {"index": 2, "kind": "rewrite", "dependencies": ["toml"],
	     "files": [{"path": "requirements.txt", "source": "split"}, {"path": "app/config.py", "source": "migrated"}],
	     "insertions": 1, "deletions": 2, "label": "fix_first", "risk_reduction": 70, "title": "replace toml with tomllib (stdlib)"}]}`)
	return api, id
}

func TestSplitDryRunOffersStackWithPerPartRisk(t *testing.T) {
	api, id := setupSplitJob(t)
	rec, out := call(t, api, "POST", id, `{"dry_run": true}`)
	if rec.Code != 200 {
		t.Fatalf("dry run: %d %s", rec.Code, rec.Body.String())
	}
	sp := out["split"].(map[string]any)
	prs := sp["prs"].([]any)
	if sp["available"] != true || len(prs) != 2 {
		t.Fatalf("split = %v", sp)
	}
	p1, p2 := prs[0].(map[string]any), prs[1].(map[string]any)
	if p1["title"] != "DepExit (1/2): quick wins: remove six" || p2["branch"] != "depexit/migrate-"+id+"-part2" {
		t.Fatalf("parts: %v / %v", p1["title"], p2["branch"])
	}
	if !strings.Contains(fmt.Sprint(p1["risk"]), "Part 1 of 2") || strings.Contains(fmt.Sprint(p2["risk"]), "Part 2 of 2") {
		t.Fatalf("only non-final parts carry the untested-on-its-own note: %v | %v", p1["risk"], p2["risk"])
	}
	if !strings.Contains(p1["body"].(string), "Dependency Exit Capsule") || strings.Contains(p2["body"].(string), "Dependency Exit Capsule") {
		t.Fatal("the full capsule belongs in part 1 only")
	}
}

func TestSplitCreatesStackedPRs(t *testing.T) {
	fake := &fakeGitHubPush{push: true, patched: map[int]string{}}
	t.Setenv("GITHUB_API_URL", fake.server(t))
	api, id := setupSplitJob(t)
	rec, out := call(t, api, "POST", id, `{"token": "`+testToken+`", "split": true}`)
	if rec.Code != 201 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	stack := out["stack"].([]any)
	if len(stack) != 2 || out["number"].(float64) != 11 {
		t.Fatalf("result: %v", out)
	}
	// part 1 targets main; part 2 targets part 1's branch (stacked)
	if fake.pulls[0]["base"] != "main" || fake.pulls[1]["base"] != "depexit/migrate-"+id+"-part1" {
		t.Fatalf("bases: %v / %v", fake.pulls[0]["base"], fake.pulls[1]["base"])
	}
	// commit chain: part 1 on the analysed commit, part 2 on part 1's last commit
	parents := func(i int) string { return fake.commits[i]["parents"].([]any)[0].(string) }
	if len(fake.commits) != 3 || parents(0) != "abc123def4567890" || parents(1) != "c1" || parents(2) != "c2" {
		t.Fatalf("commit parents: %v", fake.commits)
	}
	// manifest of part 1 comes from split/1, not from the final workspace
	if len(fake.blobs) == 0 || fake.blobs[0] != "dG9tbD09MC4xMC4yCg==" { // base64("toml==0.10.2\n")
		t.Fatalf("part 1 manifest blob: %v", fake.blobs)
	}
	for num, body := range fake.patched {
		if !strings.Contains(body, "#11") || !strings.Contains(body, "#12") || strings.Contains(body, stackPlaceholder) {
			t.Fatalf("PR %d body is not linked to the stack:\n%s", num, body)
		}
	}
	saved, _ := os.ReadFile(filepath.Join(api.store.jobDir(id), "pull_request.json"))
	if !strings.Contains(string(saved), `"stack"`) {
		t.Fatal("stack not saved")
	}
}

func TestSplitRefusesForkWithClearError(t *testing.T) {
	fake := &fakeGitHubPush{push: false, patched: map[int]string{}}
	t.Setenv("GITHUB_API_URL", fake.server(t))
	api, id := setupSplitJob(t)
	rec, out := call(t, api, "POST", id, `{"token": "`+testToken+`", "split": true}`)
	if rec.Code != 409 || out["error"].(map[string]any)["code"] != "split_needs_push_access" || len(fake.pulls) != 0 {
		t.Fatalf("fork split: %d %v", rec.Code, out)
	}
}
