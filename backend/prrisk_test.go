package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func reasonsText(r prRisk) string {
	var s []string
	for _, x := range r.Reasons {
		s = append(s, x.Level+": "+x.Text)
	}
	return strings.Join(s, "\n")
}

func TestPRRiskLowForSmallVerifiedChange(t *testing.T) {
	r := assessPRRisk(prRiskInput{Verdict: "safe_to_migrate", MigratedStatus: "passed", MigratedTotal: 10, Files: 2, Lines: 6,
		Deps: []prRiskDep{{Name: "requests", Strategy: "upgrade", HasMigration: true, Applied: true, Model: "gemma-4-31b-it",
			Confidence: 0.9, PriorityLabel: "fix_first", Outcome: "reduced"}}}) // manifest-only: no code files
	if r.Level != "low" || r.ForceDraft || r.RequireConfirm || len(r.Reasons) != 0 {
		t.Fatalf("want low, got %s\n%s", r.Level, reasonsText(r))
	}
	if md := prRiskMarkdown(r, false); !strings.Contains(md, "[!NOTE]") || !strings.Contains(md, "review risk: low") {
		t.Fatalf("markdown: %s", md)
	}
}

func TestPRRiskCautionForLargeOrUntestedRewrites(t *testing.T) {
	r := assessPRRisk(prRiskInput{Verdict: "migrate_with_care", MigratedStatus: "passed", MigratedTotal: 4, Files: 12, Lines: 340,
		Deps: []prRiskDep{
			{Name: "appdirs", Strategy: "replace", HasMigration: true, Applied: true, CodeFiles: 3, TestFiles: 0,
				Model: "groq:openai/gpt-oss-120b", Confidence: 0.8, PriorityLabel: "fix_first"},
			{Name: "fpdf", Strategy: "replace", HasMigration: true, Applied: false},
		}})
	txt := reasonsText(r)
	if r.Level != "caution" || r.RequireConfirm {
		t.Fatalf("want caution, got %s\n%s", r.Level, txt)
	}
	for _, want := range []string{"Large change: 12 files", "no test reaches", "fix first", "fallback", "NOT included"} {
		if !strings.Contains(txt, want) {
			t.Errorf("missing reason %q in\n%s", want, txt)
		}
	}
}

func TestPRRiskHighForRegressionsHugeDiffOrRiskierChange(t *testing.T) {
	cases := map[string]prRiskInput{
		"regression": {MigratedStatus: "tests_failed", MigratedTotal: 5, Regressed: []string{"tests/test_a.py::test_x"}, Files: 1, Lines: 4},
		"install":    {MigratedStatus: "install_failed", Files: 1, Lines: 2},
		"huge":       {MigratedStatus: "passed", MigratedTotal: 5, Files: 30, Lines: 900},
		"riskier": {MigratedStatus: "passed", MigratedTotal: 5, Files: 1, Lines: 2,
			Deps: []prRiskDep{{Name: "x", Strategy: "replace", HasMigration: true, Applied: true, Outcome: "increased", Model: "gemma-4"}}},
	}
	for name, in := range cases {
		r := assessPRRisk(in)
		if r.Level != "high" || !r.ForceDraft || !r.RequireConfirm || r.ConfirmPhrase != prConfirmPhrase {
			t.Errorf("%s: want high+draft+confirm, got %+v", name, r)
		}
	}
	if md := prRiskMarkdown(assessPRRisk(cases["regression"]), true); !strings.Contains(md, "[!CAUTION]") ||
		!strings.Contains(md, "opened as draft") || !strings.Contains(md, "test_x") {
		t.Fatalf("markdown: %s", md)
	}
}

func TestPullRequestHighRiskNeedsConfirmationAndIsDraft(t *testing.T) {
	fake := &fakeGitHub{}
	srv := httptestServer(t, fake)
	t.Setenv("GITHUB_API_URL", srv)
	api, id := setupPRJob(t)
	// make the sandbox show a regression -> high review risk
	p := filepath.Join(api.store.jobDir(id), "capsule.json")
	raw, _ := os.ReadFile(p)
	c := strings.Replace(string(raw), `"compatibility_gaps": []`,
		`"compatibility_gaps": [{"test_id": "tests/test_cfg.py::test_load", "change": "regressed", "explanation": "x"}]`, 1)
	writeFile(t, p, c)

	rec, out := call(t, api, "POST", id, `{"dry_run": true}`)
	plan := out["plan"].(map[string]any)
	risk := plan["risk"].(map[string]any)
	if rec.Code != 200 || risk["level"] != "high" || risk["require_confirm"] != true ||
		!strings.HasPrefix(plan["body"].(string), "> [!CAUTION]") {
		t.Fatalf("dry run: %d %v", rec.Code, risk)
	}
	before := len(fake.calls)
	if rec, out := call(t, api, "POST", id, `{"token": "`+testToken+`"}`); rec.Code != 409 ||
		out["error"].(map[string]any)["code"] != "confirmation_required" || len(fake.calls) != before {
		t.Fatalf("unconfirmed high-risk PR must be refused before calling GitHub: %d %v", rec.Code, out)
	}
	rec, _ = call(t, api, "POST", id, `{"token": "`+testToken+`", "confirm": "I understand", "draft": false}`)
	if rec.Code != 201 {
		t.Fatalf("confirmed: %d %s", rec.Code, rec.Body.String())
	}
	if fake.prBody["draft"] != true || !strings.Contains(fake.prBody["body"].(string), "opened as draft") {
		t.Fatalf("high-risk PR must be a draft: %v", fake.prBody["draft"])
	}
}

func httptestServer(t *testing.T, f *fakeGitHub) string {
	t.Helper()
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	return srv.URL
}
