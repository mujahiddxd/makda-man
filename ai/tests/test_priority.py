"""Prioritisation: severity x impact x change cost."""
from app import models, priority


def blast(direct_files, indirect=0, total=20, tests=0, entries=(), lines=None):
    return {"direct": [{"file": f, "lines": []} for f in direct_files], "entry_points": list(entries),
            "stats": {"direct_files": len(direct_files), "lines": lines if lines is not None else len(direct_files),
                      "indirect_files": indirect, "test_files": tests, "total_test_files": 5, "total_modules": total}}


def usage(files, kind="call", per_file=1):
    return {"locations": [{"file": f, "line": n + 1, "kind": kind, "code": "x"} for f in files for n in range(per_file)]}


def test_small_dependency_in_the_core_is_fix_first():
    # 2 lines in one core module, but 15 of 20 modules import it, it reaches main.py and no test covers it
    imp = priority.impact(blast(["pkg/core.py"], indirect=14, entries=["pkg/main.py"], lines=2), usage(["pkg/core.py"]))
    assert imp["score"] >= 70 and any("main execution path" in r for r in imp["reasons"])
    assert any("No test reaches" in r for r in imp["reasons"])
    cost = priority.change_cost("upgrade", usage(["pkg/core.py"]), set())
    p = priority.assess(50, imp, cost, reduction=40)
    assert p["label"] == "fix_first" and p["quick_win"]
    models.Priority.model_validate(p)


def test_large_low_severity_change_is_deferred():
    files = [f"pkg/m{i}.py" for i in range(12)]
    imp = priority.impact(blast(files[:3], total=40, tests=2), usage(files[:3]))
    cost = priority.change_cost("replace", usage(files, per_file=5), set())
    assert cost["score"] >= 50 and cost["files"] == 12
    p = priority.assess(25, imp, cost, reduction=10)
    assert p["label"] == "monitor" and p["deferred"] and "Defer" in p["recommendation"]


def test_sandbox_regression_forces_fix_first_and_test_only_use_is_low_impact():
    imp = priority.impact(blast(["pkg/a.py"], total=50, tests=1), usage(["pkg/a.py"]), has_regression=True)
    assert imp["score"] >= 90
    assert priority.assess(25, imp, priority.change_cost("upgrade", None, set()))["label"] == "fix_first"
    test_only = priority.impact(blast(["tests/test_a.py"], total=50), usage(["tests/test_a.py"]))
    assert test_only["score"] <= 15 and "Only used by tests" in test_only["reasons"][0]


def test_labels_and_summary():
    none = priority.impact(None, None)
    assert none["score"] == 0
    keep = priority.change_cost("keep", None, set())
    high_contained = priority.assess(70, {**none, "score": 10}, keep)
    moderate = priority.assess(30, {**none, "score": 10}, keep)
    healthy = priority.assess(5, none, keep)
    assert (high_contained["label"], moderate["label"], healthy["label"]) == ("plan", "monitor", "ok")
    s = priority.summarize([("a", high_contained), ("b", moderate), ("c", healthy)])
    assert s["counts"] == {"fix_first": 0, "plan": 1, "monitor": 1, "ok": 1} and s["order"] == ["a", "b"]
    models.PrioritySummary.model_validate(s)
