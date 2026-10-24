"""Split the tested migration into a stack of small pull requests.

  PR 1         quick wins: every manifest-only change (upgrade / declare / remove without code edits)
  PR 2..n      one PR per code rewrite (dependencies that edit the same file stay together), most urgent first

The PRs are stacked: PR k contains everything of PR k-1 plus its own change, so shared files such as requirements.txt
never conflict. Manifests for each step are produced by the same deterministic rewriter as the migration, applied to
the cumulative set of proposals; the last step must reproduce the tested workspace byte for byte, otherwise the split
is not offered. Only that final state ran in the sandbox, which every PR states."""
from __future__ import annotations

import difflib
import shutil
from pathlib import Path

from . import state
from .materialize import _rewrite_manifests

PRIORITY_RANK = {"fix_first": 3, "plan": 2, "monitor": 1, "ok": 0}


def _read(p: Path) -> str | None:
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _counts(a: str | None, b: str | None) -> tuple[int, int]:
    ins = dels = 0
    for line in difflib.unified_diff((a or "").splitlines(), (b or "").splitlines(), lineterm=""):
        if line.startswith("+") and not line.startswith("+++"):
            ins += 1
        elif line.startswith("-") and not line.startswith("---"):
            dels += 1
    return ins, dels


def plan(job_dir: Path, deps: list[dict], proposals: dict, mat: dict, install_files: list[str],
         priorities: dict[str, dict], reductions: dict[str, int]) -> dict:
    repo, mig = job_dir / "repo", job_dir / "runs" / "migrated" / "repo"
    stage_root = job_dir / "split"
    shutil.rmtree(stage_root, ignore_errors=True)

    def unavailable(reason: str) -> dict:
        out = {"available": False, "reason": reason, "groups": []}
        state.write(job_dir, "split.json", out)
        return out

    if not mig.exists():
        return unavailable("No migrated workspace was built.")
    applied = sorted(n for n, a in (mat.get("applied") or {}).items()
                     if a.get("applied") and (proposals.get(n) or {}).get("strategy") not in (None, "keep"))
    if not applied:
        return unavailable("No migration was applied.")

    code: dict[str, set[str]] = {n: set() for n in applied}
    for f in mat.get("files", []):
        if f.get("status") == "applied":
            for n in f.get("deps", []):
                if n in code:
                    code[n].add(f["path"])

    # dependencies that edit the same file must ship together (union-find)
    parent = {n: n for n in applied}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    by_file: dict[str, list[str]] = {}
    for n, files in code.items():
        for f in files:
            by_file.setdefault(f, []).append(n)
    for names in by_file.values():
        for other in names[1:]:
            parent[find(other)] = find(names[0])
    comps: dict[str, list[str]] = {}
    for n in applied:
        if code[n]:
            comps.setdefault(find(n), []).append(n)

    def urgency(names: list[str]) -> tuple:
        ps = [priorities.get(n) or {} for n in names]
        return (max(PRIORITY_RANK.get(p.get("label"), 0) for p in ps), max(p.get("priority", 0) for p in ps))

    quick = [n for n in applied if not code[n]]
    rewrites = sorted((sorted(c) for c in comps.values()), key=urgency, reverse=True)
    groups = ([("quick_wins", quick)] if quick else []) + [("rewrite", g) for g in rewrites]
    if len(groups) < 2:
        return unavailable("The migration is a single change; there is nothing to split.")

    manifests = sorted({c["file"] for c in mat.get("manifest_changes", [])})
    prev = {rel: _read(repo / rel) for rel in manifests}
    cumulative: dict[str, dict] = {}
    out_groups = []
    for k, (kind, names) in enumerate(groups, start=1):
        cumulative.update({n: proposals[n] for n in names})
        dst = stage_root / str(k)
        for rel in manifests:
            (dst / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(repo / rel, dst / rel)
        _rewrite_manifests(repo, dst, deps, cumulative, install_files)
        files, ins, dels = [], 0, 0
        for rel in manifests:
            now = _read(dst / rel)
            if now != prev[rel]:
                files.append({"path": rel, "source": "split"})
                i, d = _counts(prev[rel], now)
                ins, dels = ins + i, dels + d
            prev[rel] = now
        for rel in sorted({f for n in names for f in code[n]}):
            files.append({"path": rel, "source": "migrated"})
            i, d = _counts(_read(repo / rel), _read(mig / rel))
            ins, dels = ins + i, dels + d
        best = max((priorities.get(n) or {} for n in names), key=lambda p: PRIORITY_RANK.get(p.get("label"), 0))
        out_groups.append({
            "index": k, "kind": kind, "dependencies": sorted(names), "files": files,
            "insertions": ins, "deletions": dels, "label": best.get("label", "ok"),
            "risk_reduction": sum(reductions.get(n, 0) for n in names),
            "title": _title(kind, names, proposals),
        })

    # the last step must be exactly the tested workspace
    for rel in manifests:
        if prev[rel] != _read(mig / rel):
            shutil.rmtree(stage_root, ignore_errors=True)
            return unavailable(f"Splitting could not reproduce the tested {rel}; use a single pull request.")
    if any(not g["files"] for g in out_groups):
        shutil.rmtree(stage_root, ignore_errors=True)
        return unavailable("A step of the split would change no files; use a single pull request.")
    out = {"available": True, "reason": None, "groups": out_groups,
           "note": "Only the final state (all parts together) ran in the Docker sandbox."}
    state.write(job_dir, "split.json", out)
    return out


def _title(kind: str, names: list[str], proposals: dict) -> str:
    def one(n: str) -> str:
        p = proposals[n]
        s, pkg = p["strategy"], p.get("package")
        if s == "replace":
            return f"replace {n} with {pkg}"
        if s == "stdlib":
            return f"replace {n} with {pkg} (stdlib)"
        if s == "remove":
            return f"remove {n}"
        if s == "declare":
            return f"declare {n}"
        return f"upgrade {n}"
    parts = [one(n) for n in names]
    text = ", ".join(parts[:3]) + (f" and {len(parts) - 3} more" if len(parts) > 3 else "")
    return ("quick wins: " if kind == "quick_wins" else "") + text
