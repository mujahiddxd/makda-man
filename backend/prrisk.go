package main

// Review-risk gate for pull requests: before a migration leaves DepExit as a PR, rate how hard it is to review safely.
//
//	low     normal flow
//	caution the dialog warns and defaults to a draft PR
//	high    the PR is always opened as a draft and the caller must confirm with prConfirmPhrase (enforced here, not
//	        only in the UI)
//
// Every reason comes from evidence already in the capsule (sandbox results, patch size, blast radius, priorities,
// risk before/after), so the warning can always say exactly why.

import (
	"fmt"
	"path"
	"strings"
)

const prConfirmPhrase = "I understand"

// Patch size thresholds (files / changed lines). Big diffs get skimmed instead of reviewed.
const (
	prCautionFiles, prCautionLines = 10, 300
	prHighFiles, prHighLines       = 25, 800
)

var manifestNames = map[string]bool{
	"requirements.txt": true, "pyproject.toml": true, "setup.py": true, "setup.cfg": true, "Pipfile": true,
	"Pipfile.lock": true, "poetry.lock": true, "package.json": true, "package-lock.json": true,
}

func isManifest(p string) bool {
	base := path.Base(p)
	return manifestNames[base] || (strings.HasPrefix(base, "requirements") && strings.HasSuffix(base, ".txt"))
}

type prRiskReason struct {
	Level string `json:"level"` // caution | high
	Text  string `json:"text"`
}

type prRisk struct {
	Level          string         `json:"level"` // low | caution | high
	Reasons        []prRiskReason `json:"reasons"`
	Files          int            `json:"files"`
	Lines          int            `json:"lines"`
	ForceDraft     bool           `json:"force_draft"`
	RequireConfirm bool           `json:"require_confirm"`
	ConfirmPhrase  string         `json:"confirm_phrase,omitempty"`
}

type prRiskDep struct {
	Name, Strategy, PriorityLabel, Outcome, Model string
	HasMigration, Applied                         bool
	CodeFiles, TestFiles                          int
	Confidence                                    float64
	Reduction                                     int
	Regressed                                     []string // tests this dependency's migration broke
}

type prRiskInput struct {
	Verdict        string
	MigratedStatus string
	MigratedTotal  int
	Regressed      []string // test ids (or "install") that pass before the migration and fail after it
	Files, Lines   int
	Deps           []prRiskDep
	StackNote      string // split mode: why this part was not tested on its own (empty for the last part)
}

func assessPRRisk(in prRiskInput) prRisk {
	r := prRisk{Files: in.Files, Lines: in.Lines, Reasons: []prRiskReason{}}
	add := func(level, format string, a ...any) {
		r.Reasons = append(r.Reasons, prRiskReason{Level: level, Text: fmt.Sprintf(format, a...)})
	}

	// what the sandbox proved
	if len(in.Regressed) > 0 {
		shown := in.Regressed
		if len(shown) > 5 {
			shown = shown[:5]
		}
		add("high", "%d test(s) pass before the migration and fail after it: %s", len(in.Regressed), strings.Join(shown, ", "))
	}
	switch in.MigratedStatus {
	case "install_failed", "error", "timeout":
		add("high", "The migrated project did not install or run in the sandbox (%s), so nothing was verified", in.MigratedStatus)
	case "network_error":
		add("caution", "The sandbox could not download packages from PyPI (network), so the change is not verified by tests")
	case "no_tests":
		add("caution", "The project has no tests, so the change is not verified by execution")
	}
	if in.Verdict == "blocked" && len(in.Regressed) == 0 && in.MigratedStatus == "passed" {
		add("high", "The analysis verdict is blocked")
	}
	if in.MigratedTotal == 0 && in.MigratedStatus == "passed" {
		add("caution", "No tests ran, so the change is not verified by execution")
	}

	if in.StackNote != "" {
		add("caution", "%s", in.StackNote)
	}

	// how big it is
	switch {
	case in.Files >= prHighFiles || in.Lines >= prHighLines:
		add("high", "Very large change: %d files, %d changed lines; consider splitting it into smaller PRs", in.Files, in.Lines)
	case in.Files >= prCautionFiles || in.Lines >= prCautionLines:
		add("caution", "Large change: %d files, %d changed lines", in.Files, in.Lines)
	}

	// what it touches
	var partial, worse, core, blind, unsure []string
	for _, d := range in.Deps {
		if !d.HasMigration || d.Strategy == "keep" {
			continue
		}
		if !d.Applied {
			partial = append(partial, d.Name)
			continue
		}
		if d.Outcome == "increased" {
			worse = append(worse, d.Name)
		}
		if d.CodeFiles > 0 && d.PriorityLabel == "fix_first" {
			core = append(core, d.Name)
		}
		if d.CodeFiles > 0 && d.TestFiles == 0 {
			blind = append(blind, d.Name)
		}
		if d.CodeFiles > 0 && (d.Confidence > 0 && d.Confidence < 0.6 || d.Model == "" || !strings.HasPrefix(d.Model, "gemma")) {
			unsure = append(unsure, d.Name)
		}
	}
	if len(worse) > 0 {
		add("high", "These changes raise the dependency risk instead of lowering it: %s", strings.Join(worse, ", "))
	}
	if len(core) > 0 {
		add("caution", "Rewrites code for high-impact (fix first) dependencies: %s", strings.Join(core, ", "))
	}
	if len(blind) > 0 {
		add("caution", "Rewritten code that no test reaches (a break would go unnoticed): %s", strings.Join(blind, ", "))
	}
	if len(unsure) > 0 {
		add("caution", "Code edits with low confidence or made by a fallback / deterministic path: %s", strings.Join(unsure, ", "))
	}
	if len(partial) > 0 {
		add("caution", "Proposed migrations that are NOT included because they could not be applied: %s", strings.Join(partial, ", "))
	}

	r.Level = "low"
	for _, x := range r.Reasons {
		if x.Level == "high" {
			r.Level = "high"
			break
		}
		r.Level = "caution"
	}
	if r.Level == "high" {
		r.ForceDraft, r.RequireConfirm, r.ConfirmPhrase = true, true, prConfirmPhrase
	}
	return r
}

// prRiskMarkdown is the block at the very top of the PR description (GitHub alert syntax).
func prRiskMarkdown(r prRisk, draft bool) string {
	var b strings.Builder
	kind, title := "NOTE", "low"
	switch r.Level {
	case "caution":
		kind, title = "WARNING", "caution"
	case "high":
		kind, title = "CAUTION", "HIGH"
	}
	fmt.Fprintf(&b, "> [!%s]\n> **DepExit review risk: %s** · %d files, %d changed lines", kind, title, r.Files, r.Lines)
	if draft {
		b.WriteString(" · opened as draft")
	}
	b.WriteString("\n")
	if len(r.Reasons) == 0 {
		b.WriteString("> Small change, verified in the sandbox. A normal review is enough.\n")
	}
	for _, x := range r.Reasons {
		fmt.Fprintf(&b, "> - %s\n", mdEscape(x.Text))
	}
	b.WriteString("\n")
	return b.String()
}
