"""Risk projection: before -> after scoring of proposed dependency changes (never rejects a proposal)."""
from app import models, projection


def ind(code, detail="", severity="medium", **extra):
    return {"code": code, "severity": severity, "detail": detail or code, "evidence": [{"source": "pypi"}],
            "provenance": "evidence", **extra}


VALIMODEL = [ind("UNDECLARED"), ind("UNMAINTAINED"), ind("PRIVATE_API_USE")]  # 20 + 20 + 15 = 55


def test_replace_with_healthy_package_eliminates_risk():
    p = {"strategy": "replace", "package": "pydantic", "version_spec": ">=2,<3",
         "projection": {"package": "pydantic", "version": "2.9.2", "released": "2025-01-01", "indicators": [],
                        "alternatives": [{"package": "attrs", "version": "24.1.0", "score": 20, "level": "medium"}]}}
    rc = projection.compare("valimodel", VALIMODEL, p, "python", "3.12")
    assert rc["before"] == {"score": 55, "level": "high"}
    assert rc["after"]["score"] == 0 and rc["after"]["package"] == "pydantic" and rc["after"]["version"] == "2.9.2"
    assert rc["outcome"] == "eliminated" and rc["reduction"] == 55 and rc["reduction_pct"] == 100
    assert {r["code"] for r in rc["resolved"]} == {"UNDECLARED", "UNMAINTAINED", "PRIVATE_API_USE"}
    assert any("no known advisories" in w for w in rc["why_chosen"])
    assert any("attrs" in w and "higher than" in w for w in rc["why_chosen"])
    models.RiskChange.model_validate(rc)


def test_upgrade_keeps_code_level_risk_and_reports_partial_reduction():
    before = [ind("KNOWN_VULNERABILITY", "3 advisories", "high", count=3), ind("PRIVATE_API_USE")]  # 40 + 15
    p = {"strategy": "upgrade", "package": "requests", "version_spec": ">=2.32",
         "projection": {"package": "requests", "version": "2.32.3", "indicators": [], "alternatives": []}}
    rc = projection.compare("requests", before, p)
    assert rc["after"]["score"] == 15 and rc["outcome"] == "reduced" and rc["reduction"] == 40
    assert [r["code"] for r in rc["resolved"]] == ["KNOWN_VULNERABILITY"]
    assert [r["code"] for r in rc["remaining"]] == ["PRIVATE_API_USE"]  # same code still calls the private API


def test_change_that_raises_risk_is_shown_not_rejected():
    p = {"strategy": "replace", "package": "oldthing", "version_spec": None,
         "projection": {"package": "oldthing", "version": "0.1", "alternatives": [],
                        "indicators": [ind("UNMAINTAINED"), ind("DEPRECATED_PACKAGE", severity="high")]}}
    rc = projection.compare("x", [ind("OUTDATED", severity="low")], p)
    assert rc["outcome"] == "increased" and rc["reduction"] < 0
    assert {r["code"] for r in rc["introduced"]} == {"UNMAINTAINED", "DEPRECATED_PACKAGE"}
    assert "higher" in rc["explanation"]


def test_keep_remove_stdlib_and_summary():
    keep = projection.compare("a", [ind("OUTDATED", severity="low")], {"strategy": "keep"})
    remove = projection.compare("b", VALIMODEL, {"strategy": "remove"})
    stdlib = projection.compare("tomlread", [ind("UNMAINTAINED"), ind("STDLIB_REPLACEMENT_AVAILABLE")],
                                {"strategy": "stdlib", "package": "tomllib", "projection": {"alternatives": []}})
    assert keep["outcome"] == "unchanged" and keep["after"]["score"] == keep["before"]["score"] == 5
    assert remove["after"]["score"] == 0 and stdlib["after"]["score"] == 0
    s = projection.summarize([keep, remove, stdlib])
    assert s["total_before"] == 5 + 55 + 35 and s["total_after"] == 5
    assert s["at_risk_before"] == 2 and s["at_risk_after"] == 0
    assert s["eliminated"] == 2 and s["unchanged"] == 1
    models.RiskReduction.model_validate(s)
