"""Prioritisation on three separate axes instead of one risk number.

* severity    - how bad the package itself is (the deterministic risk score, incl. sandbox evidence)
* impact      - how much of the project breaks if it misbehaves (blast radius: reach through the import graph,
                entry points, depth of coupling, whether any test would notice)
* change cost - how big the proposed fix is (strategy, usage footprint, files actually rewritten)

severity x impact picks the quadrant (fix first / plan / monitor), so a tiny package wired into the core of the app
is not ranked like one used in a single script; benefit vs change cost flags quick wins and changes worth deferring.
Everything here is computed from evidence already in the capsule (provenance "derived")."""
from __future__ import annotations

import math

SEVERITY_HIGH = 45   # risk "high" or "critical"
SEVERITY_MIN = 20    # below this ("low"/"none") the dependency needs no action
IMPACT_HIGH = 40
COUPLING_KINDS = {"private_api", "monkeypatch", "subclass"}
LABELS = ("fix_first", "plan", "monitor", "ok")


def impact(blast: dict | None, usage: dict | None, group: str = "main", has_regression: bool = False) -> dict:
    """0-100: how far trouble in this dependency would spread through the project."""
    locs = (usage or {}).get("locations") or []
    if not blast or not locs:
        return {"score": 0, "level": "none", "reach_pct": 0, "reasons": ["Not imported anywhere in the code"]}
    st = blast.get("stats") or {}
    direct_runtime = sum(1 for f in blast.get("direct", []) if not _is_test(f["file"]))
    reached = direct_runtime + st.get("indirect_files", 0)
    total = max(st.get("total_modules") or reached or 1, reached, 1)
    reach = reached / total
    lines = st.get("lines", 0)
    entries = blast.get("entry_points") or []
    kinds = {k for l in locs for k in ([l.get("kind")] if l.get("kind") else [])}
    coupled = bool(kinds & COUPLING_KINDS)
    untested = reached > 0 and st.get("test_files", 0) == 0
    reasons = []
    if reached == 0 or group != "main":
        score = min(15, 5 + lines)  # only tests/tooling use it: a failure shows up in CI, not in production
        reasons.append("Only used by tests or tooling, not by the running application")
    else:
        score = (45 * math.sqrt(reach) + 15 * min(1.0, lines / 30) + 15 * bool(entries) + 10 * coupled
                 + 15 * untested)
        reasons.append(f"Reaches {reached} of {total} project modules ({round(100 * reach)}%)"
                       + (f" through {st.get('indirect_files', 0)} importing module(s)" if st.get("indirect_files") else ""))
        if entries:
            reasons.append("On the main execution path (reaches " + ", ".join(entries[:3]) + ")")
        if coupled:
            reasons.append("Deep coupling: " + ", ".join(sorted(kinds & COUPLING_KINDS)).replace("_", " ")
                           + " - behaviour changes are likely to surface as bugs")
        if untested:
            reasons.append("No test reaches this code, so a breaking change would go unnoticed")
        elif st.get("test_files"):
            reasons.append(f"{st['test_files']} of {st.get('total_test_files', 0)} test file(s) exercise it")
    if has_regression:
        score = max(score, 90)
        reasons.insert(0, "Tests failed in the sandbox because of this dependency")
    score = int(round(min(100, score)))
    return {"score": score, "level": _level(score), "reach_pct": round(100 * reach), "reasons": reasons}


def change_cost(strategy: str, usage: dict | None, before_codes: set[str], files_changed: list[str] | None = None,
                code_changes_needed: bool | None = None) -> dict:
    """0-100: how much work and review the proposed fix needs."""
    locs = (usage or {}).get("locations") or []
    files = sorted({l["file"] for l in locs})
    lines = len({(l["file"], l["line"]) for l in locs})
    rewrites_code = strategy in ("replace", "stdlib") or (strategy == "remove" and locs) or bool(code_changes_needed)
    base = {"keep": 0, "declare": 5, "upgrade": 10, "remove": 10, "stdlib": 25, "replace": 30}.get(strategy, 10)
    reasons = []
    if strategy == "keep":
        return {"score": 0, "level": "none", "files": 0, "lines": 0, "reasons": ["No change proposed"]}
    if strategy == "upgrade" and "MAJOR_VERSIONS_BEHIND" in before_codes:
        base += 20
        reasons.append("Major version jump: API breaks are possible")
    n_files = len(files_changed) if files_changed else (len(files) if rewrites_code else 1)
    if rewrites_code:
        base += 30 * min(1.0, len(files) / 10) + 20 * min(1.0, lines / 50)
        reasons.append(f"Rewrites code at {lines} line(s) in {len(files)} file(s)")
        if any(l.get("kind") in COUPLING_KINDS for l in locs):
            base += 15
            reasons.append("Uses private APIs / monkeypatching that the new package may not offer")
    else:
        reasons.append("Manifest-only change" + (" (no code edits)" if strategy in ("declare", "upgrade") else ""))
    if files_changed:
        reasons.append(f"Migration touched {len(files_changed)} file(s)")
    score = int(round(min(100, base)))
    return {"score": score, "level": _level(score), "files": n_files, "lines": lines if rewrites_code else 0,
            "reasons": reasons}


def assess(severity: int, imp: dict, cost: dict, reduction: int = 0) -> dict:
    """Quadrant label + numeric priority (for sorting) + a one-line recommendation."""
    s, i, c = severity, imp["score"], cost["score"]
    if s < SEVERITY_MIN and i < 90:
        label = "ok"
    elif s >= SEVERITY_HIGH and i >= IMPACT_HIGH:
        label = "fix_first"
    elif s >= SEVERITY_HIGH or i >= IMPACT_HIGH:
        label = "plan"  # risky but contained, or moderate risk wired through the project
    else:
        label = "monitor"
    if i >= 90 and s >= SEVERITY_MIN:  # proven breakage (sandbox) or near-total reach: never wait
        label = "fix_first"
    quick_win = reduction >= 15 and c <= 25
    defer = label in ("plan", "monitor") and c >= 50 and reduction < 25
    if defer:
        label = "monitor"
    priority = round(0.55 * s + 0.45 * i + (8 if quick_win else 0) - (8 if defer else 0))
    text = {
        "fix_first": f"Fix first: severity {s} and impact {i} are both high.",
        "plan": (f"Plan the fix: severity {s} is high but the impact ({i}) is contained." if s >= SEVERITY_HIGH else
                 f"Plan the fix: moderate severity ({s}) but it reaches far into the project (impact {i})."),
        "monitor": f"Monitor: severity {s} and impact {i} are both moderate.",
        "ok": f"No action needed: severity {s}.",
    }[label]
    if defer:
        text = (f"Defer and monitor: the fix is large (change cost {c}) for a small gain (-{reduction} risk points); "
                "revisit when touching this code anyway.")
    elif quick_win:
        text += f" Quick win: small change (cost {c}) removes {reduction} risk points."
    return {"label": label, "priority": max(0, priority), "severity": s, "impact": imp, "change_cost": cost,
            "quick_win": quick_win, "deferred": defer, "recommendation": text, "provenance": "derived"}


def summarize(items: list[tuple[str, dict]]) -> dict:
    """items: (dependency name, assess() result). Counts per label and the ordered work list."""
    counts = {k: 0 for k in LABELS}
    for _, p in items:
        counts[p["label"]] += 1
    order = [n for n, p in sorted(items, key=lambda x: -x[1]["priority"]) if p["label"] != "ok"]
    return {"counts": counts, "order": order, "quick_wins": [n for n, p in items if p["quick_win"]],
            "deferred": [n for n, p in items if p["deferred"]],
            "thresholds": {"severity_high": SEVERITY_HIGH, "severity_min": SEVERITY_MIN, "impact_high": IMPACT_HIGH}}


def _is_test(rel: str) -> bool:
    parts = rel.split("/")
    name = parts[-1]
    return (parts[0] in {"tests", "test", "__tests__"} or name.startswith("test_") or name == "conftest.py"
            or ".test." in name or ".spec." in name)


def _level(score: int) -> str:
    return "high" if score >= 60 else "medium" if score >= 30 else "low" if score > 0 else "none"
