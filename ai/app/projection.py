"""Risk projection: score each dependency as it will look after its proposed change, with the same deterministic
engine the scan uses, so every proposal can show its risk before -> after and what the change fixes.

Proposals are never rejected here; a change that does not lower the risk is reported as such."""
from __future__ import annotations

import asyncio

from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version

from . import npm, registry, risk, scan

# How the project's own code uses the package: fixed only when the code is rewritten for a replacement.
CODE_LEVEL = {"DEPRECATED_API_USE", "PRIVATE_API_USE", "MONKEYPATCH"}
STRATEGY_TEXT = {
    "replace": "Replace {old} with {pkg}", "upgrade": "Upgrade {old} to {ver}", "declare": "Declare {pkg} in the manifests",
    "remove": "Remove {old}", "stdlib": "Use the standard library ({pkg}) instead of {old}", "keep": "Keep {old} as it is",
}


async def target_version(name: str, spec: str | None, ecosystem: str = "python") -> str | None:
    """The version a proposal resolves to: the newest stable release that satisfies its version_spec."""
    if ecosystem == "npm":
        f = await registry.npm_package(name)
        return None if not f or f.get("_missing") else f.get("latest")
    proj = await registry.pypi_project(name)
    if not proj:
        return None
    try:
        allowed = SpecifierSet(spec or "")
    except InvalidSpecifier:
        allowed = SpecifierSet("")
    versions = []
    for v, files in (proj.get("releases") or {}).items():
        try:
            pv = Version(v)
        except InvalidVersion:
            continue
        if pv.is_prerelease or (files and all(f.get("yanked") for f in files)) or pv not in allowed:
            continue
        versions.append(pv)
    return str(max(versions)) if versions else (proj.get("info") or {}).get("version")


async def package_risk(name: str, version: str | None, py: str, ecosystem: str = "python") -> tuple[list[dict], str | None]:
    """(registry-level indicators, release date) of one package version, exactly as the scan would score it."""
    if ecosystem == "npm":
        f = await registry.npm_package(name)
        vulns = await registry.osv_query(name, version, "npm") if version else None
        released = (((f or {}).get("versions") or {}).get(version or "") or {}).get("time")
        return npm.package_indicators(name, version, f, vulns), (released or "")[:10] or None
    f = await scan._facts(name, version)
    return scan.package_indicators(name, version, f, scan._py_tuple(py)), f.get("last_release_of_pinned")


async def project(dep: dict, proposal: dict, py: str, ecosystem: str = "python") -> dict:
    """Facts about what the proposal installs (stored with the proposal; compare() turns them into before/after)."""
    strat = proposal["strategy"]
    if strat in ("keep", "remove", "stdlib"):
        return {"package": proposal.get("package") if strat == "stdlib" else None, "version": None,
                "released": None, "indicators": [], "alternatives": await _alternatives(proposal, py, ecosystem)}
    pkg = proposal.get("package") or dep["name"]
    ver = await target_version(pkg, proposal.get("version_spec"), ecosystem)
    inds, released = await package_risk(pkg, ver, py, ecosystem)
    return {"package": pkg, "version": ver, "released": released, "indicators": inds,
            "alternatives": await _alternatives(proposal, py, ecosystem)}


async def _alternatives(proposal: dict, py: str, ecosystem: str) -> list[dict]:
    """Risk of the packages the AI considered and rejected, so the choice can be compared on the same scale."""
    alts = [a for a in proposal.get("alternatives") or [] if a.get("package")][:4]

    async def one(a: dict) -> dict:
        name = a["package"].split()[0]
        ver = await target_version(name, None, ecosystem)
        if not ver:
            return {"package": name, "version": None, "score": None, "level": None}
        inds, _ = await package_risk(name, ver, py, ecosystem)
        s, lvl = risk.score(inds)
        return {"package": name, "version": ver, "score": s, "level": lvl}
    return list(await asyncio.gather(*(one(a) for a in alts)))


def _brief(ind: dict) -> dict:
    return {"code": ind["code"], "detail": ind["detail"], "points": risk.indicator_points(ind)}


def _strongest(inds: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in inds:  # one contribution per code, like risk.score()
        if i["code"] not in out or risk.indicator_points(i) > risk.indicator_points(out[i["code"]]):
            out[i["code"]] = i
    return out


def compare(name: str, before: list[dict], proposal: dict | None, ecosystem: str = "python",
            python_version: str | None = None) -> dict:
    """Before -> after risk for one dependency. `before` are its current (merged) indicators."""
    strat = (proposal or {}).get("strategy", "keep")
    raw = (proposal or {}).get("projection") or {}
    if strat == "keep" or not proposal:
        after = [dict(i) for i in before]
    elif strat in ("remove", "stdlib"):
        after = []
    else:
        after = [dict(i) for i in raw.get("indicators", [])]
        if strat in ("upgrade", "declare"):  # same package, same code: how the code uses it does not change
            after += [i for i in before if i["code"] in CODE_LEVEL or i["code"] == "DECLARED_UNUSED"]
        if not proposal.get("version_spec") and any(i["code"] == "UNPINNED" for i in before):
            after += [i for i in before if i["code"] == "UNPINNED"]
    b_score, b_level = risk.score(before)
    a_score, a_level = risk.score(after)
    b_codes, a_codes = _strongest(before), _strongest(after)
    resolved = [_brief(i) for c, i in b_codes.items() if c not in a_codes]
    remaining = [_brief(i) for c, i in a_codes.items() if c in b_codes]
    introduced = [_brief(i) for c, i in a_codes.items() if c not in b_codes]
    for lst in (resolved, remaining, introduced):
        lst.sort(key=lambda x: -x["points"])
    delta = b_score - a_score
    if a_score == 0 and b_score > 0:
        outcome = "eliminated"
    elif delta > 0:
        outcome = "reduced"
    elif delta < 0:
        outcome = "increased"
    else:
        outcome = "unchanged"

    pkg, ver = raw.get("package") or (proposal or {}).get("package"), raw.get("version")
    action = STRATEGY_TEXT.get(strat, strat).format(old=name, pkg=pkg or name, ver=ver or "the latest version")
    if strat in ("replace", "upgrade", "declare") and ver and "{ver}" not in STRATEGY_TEXT.get(strat, ""):
        action += f" {ver}"
    parts = [f"{action}: risk {b_score} ({b_level}) -> {a_score} ({a_level})"
             + (f", {delta} points lower ({round(100 * delta / b_score)}%)." if delta > 0 and b_score else
                f", {-delta} points higher." if delta < 0 else ", no change.")]
    if resolved:
        parts.append("Fixes " + ", ".join(f"{r['code']} (-{r['points']})" for r in resolved) + ".")
    if remaining:
        parts.append("Still present: " + ", ".join(f"{r['code']} ({r['points']})" for r in remaining) + ".")
    if introduced:
        parts.append("New with this change: " + ", ".join(f"{r['code']} (+{r['points']})" for r in introduced) + ".")

    why: list[str] = []  # facts about the chosen package, from the registry/OSV (same evidence as the scan)
    if strat in ("replace", "upgrade", "declare") and pkg:
        codes = set(a_codes)
        label = f"{pkg} {ver}" if ver else pkg
        if not ver:
            why.append(f"{pkg} could not be resolved on the {'npm registry' if ecosystem == 'npm' else 'PyPI'}")
        else:
            why.append(f"{label} has no known advisories (OSV)" if "KNOWN_VULNERABILITY" not in codes
                       else f"{label} still has known advisories (OSV)")
            if "UNMAINTAINED" not in codes:
                why.append("actively maintained" + (f" (released {raw['released']})" if raw.get("released") else ""))
            if "DEPRECATED_PACKAGE" not in codes:
                why.append("not deprecated")
            if ecosystem == "python" and "PY312_INCOMPATIBLE" not in codes and python_version:
                why.append(f"declares support for Python {python_version}")
    elif strat == "stdlib":
        why.append(f"{pkg or 'the standard library module'} ships with Python, so it has no release, advisory or "
                   "maintenance risk of its own")
    elif strat == "remove":
        why.append("the dependency is dropped, so none of its risks remain")
    alts = [a for a in raw.get("alternatives", []) if a.get("score") is not None]
    for a in alts:
        cmp_ = ("higher than" if a["score"] > a_score else "lower than" if a["score"] < a_score else "the same as")
        why.append(f"considered {a['package']} {a['version']}: risk {a['score']} ({a['level']}), {cmp_} this choice")
    return {
        "before": {"score": b_score, "level": b_level},
        "after": {"score": a_score, "level": a_level, "package": pkg, "version": ver},
        "reduction": delta,
        "reduction_pct": round(100 * delta / b_score) if b_score else 0,
        "outcome": outcome,
        "resolved": resolved,
        "remaining": remaining,
        "introduced": introduced,
        "after_indicators": [risk.public_indicator(i) for i in after],
        "why_chosen": why,
        "alternatives": raw.get("alternatives", []),
        "explanation": " ".join(parts),
        "provenance": "derived",
    }


def summarize(rows: list[dict]) -> dict:
    """Project-wide before -> after. rows: compare() results."""
    before = sum(r["before"]["score"] for r in rows)
    after = sum(r["after"]["score"] for r in rows)
    by_level_after = {lv: 0 for lv in ("critical", "high", "medium", "low", "none")}
    for r in rows:
        by_level_after[r["after"]["level"]] += 1
    count = lambda o: sum(1 for r in rows if r["outcome"] == o)  # noqa: E731
    return {
        "total_before": before, "total_after": after, "reduced_by": before - after,
        "reduced_pct": round(100 * (before - after) / before) if before else 0,
        "at_risk_before": sum(1 for r in rows if risk.at_risk(r["before"]["level"])),
        "at_risk_after": sum(1 for r in rows if risk.at_risk(r["after"]["level"])),
        "max_before": max((r["before"]["score"] for r in rows), default=0),
        "max_after": max((r["after"]["score"] for r in rows), default=0),
        "by_level_after": by_level_after,
        "eliminated": count("eliminated"), "reduced": count("reduced"),
        "unchanged": count("unchanged"), "increased": count("increased"),
    }
