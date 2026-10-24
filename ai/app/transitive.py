"""Transitive dependencies: the packages your dependencies pull in, checked against OSV, with the path that brings
each one into the project ("your app -> express 4.17.1 -> qs 6.5.2").

Tree sources:
  npm     package-lock.json v2/v3: the exact installed tree (node resolution: nearest node_modules first)
  python  PyPI metadata: each package's requires_dist evaluated for the target Python on Linux, resolved to the newest
          release that satisfies it (pinned versions from the manifests win). This is what pip would install for each
          requirement on its own; it is marked approximate because a real install can settle on other versions.

Steps covered here: build the tree, check every package against OSV, and report the dependency paths. Whether the
vulnerable code is reachable from the project is not assessed (direct dependencies keep their own scan)."""
from __future__ import annotations

import asyncio
import json
from collections import deque
from pathlib import Path

from packaging.markers import default_environment
from packaging.requirements import InvalidRequirement, Requirement
from packaging.version import InvalidVersion, Version

from . import registry
from .manifests import normalize

MAX_PACKAGES = 2000     # safety cap on tree size
MAX_DEPTH = 8
MAX_PATHS = 3           # dependency paths reported per package
ROOT = "your app"


def _env(py: str) -> dict:
    env = default_environment()
    major, minor = (py.split(".") + ["12"])[:2]
    env.update(python_version=f"{major}.{minor}", python_full_version=f"{major}.{minor}.0", sys_platform="linux",
               platform_system="Linux", os_name="posix", platform_machine="x86_64",
               implementation_name="cpython", platform_python_implementation="CPython", extra="")
    return env


def _best(project: dict, spec) -> str | None:
    """Newest stable, non-yanked release allowed by spec (what pip picks for one requirement)."""
    best = None
    for v, files in (project.get("releases") or {}).items():
        try:
            pv = Version(v)
        except InvalidVersion:
            continue
        if pv.is_prerelease or (files and all(f.get("yanked") for f in files)) or (spec and pv not in spec):
            continue
        if best is None or pv > best:
            best = pv
    return str(best) if best else None


# ---------------- tree builders: name -> {version, dev, parents: set[(parent name or ROOT)]} ----------------

async def python_tree(direct: list[dict], pins: dict[str, str], py: str) -> tuple[dict[str, dict], list[str]]:
    env = _env(py)
    nodes: dict[str, dict] = {}
    notes: list[str] = []
    failed: set[str] = set()  # registry lookups that failed (network): never silently treated as "no risk"
    queue: list[tuple[str, str | None, str, bool, int]] = []  # (name, version or None, parent, dev, depth)
    for d in direct:
        queue.append((d["name"], d.get("version"), ROOT, d.get("dev", False), 0))
    depth = 0
    while queue and len(nodes) < MAX_PACKAGES:
        level, queue = queue, []
        fresh = []
        for name, version, parent, dev, dep_depth in level:
            n = nodes.get(name)
            if n:  # one version per package, like pip; remember every parent for the paths
                n["parents"].add(parent)
                n["dev"] = n["dev"] and dev
                continue
            nodes[name] = {"version": version, "dev": dev, "parents": {parent}, "depth": dep_depth}
            fresh.append(name)
        if depth >= MAX_DEPTH:
            break

        async def expand(name: str) -> list[tuple[str, str | None, str, bool, int]]:
            node = nodes[name]
            proj = await registry.pypi_project(name)
            if not proj:
                failed.add(name)
                return []
            if not node["version"] or node["version"] not in (proj.get("releases") or {}):
                node["version"] = pins.get(name) or proj["info"].get("version")
            rel = await registry.pypi_release(name, node["version"])
            reqs = ((rel or {}).get("info") or {}).get("requires_dist") or []
            out = []
            for r in reqs:
                try:
                    req = Requirement(r)
                except InvalidRequirement:
                    continue
                if req.marker:
                    if "extra" in str(req.marker):
                        continue
                    try:
                        if not req.marker.evaluate(env):
                            continue
                    except Exception:  # noqa: BLE001 - unknown marker variables: keep the requirement
                        pass
                child = normalize(req.name)
                if child in nodes:
                    nodes[child]["parents"].add(name)
                    continue
                cproj = await registry.pypi_project(child)
                if not cproj and not pins.get(child):
                    failed.add(child)
                cv = pins.get(child) or (_best(cproj, req.specifier) if cproj else None)
                out.append((child, cv, name, node["dev"], node["depth"] + 1))
            return out

        for children in await asyncio.gather(*(expand(n) for n in fresh)):
            queue.extend(children)
        depth += 1
    if len(nodes) >= MAX_PACKAGES:
        notes.append(f"Dependency tree truncated at {MAX_PACKAGES} packages")
    if failed:
        notes.append("PyPI lookup failed for " + ", ".join(sorted(failed)[:10]) + (" and more" if len(failed) > 10 else "")
                     + ": their versions, dependencies and advisories could not be checked (try again later)")
    return nodes, notes


def npm_tree(repo: Path) -> tuple[dict[str, dict] | None, list[str]]:
    lock = repo / "package-lock.json"
    if not lock.is_file():
        return None, ["No package-lock.json: transitive npm dependencies were not analysed"]
    try:
        data = json.loads(lock.read_text(encoding="utf-8", errors="replace"))
    except ValueError:
        return None, ["package-lock.json is not valid JSON: transitive npm dependencies were not analysed"]
    pkgs = data.get("packages")
    if not isinstance(pkgs, dict):
        return None, ["package-lock.json v1 is not supported for transitive analysis (regenerate it with npm 7+)"]

    def name_of(path: str) -> str:
        return path.rsplit("node_modules/", 1)[-1]

    def resolve(from_path: str, child: str) -> str | None:
        base = from_path
        while True:
            cand = (base + "/" if base else "") + "node_modules/" + child
            if cand in pkgs:
                return cand
            if not base:
                return None
            cut = base.rfind("/node_modules/")
            base = base[:cut] if cut >= 0 else ""

    nodes: dict[str, dict] = {}
    by_path: dict[str, str] = {}
    root = pkgs.get("", {})
    queue = deque()
    for group in ("dependencies", "devDependencies", "optionalDependencies"):
        for child in (root.get(group) or {}):
            p = resolve("", child)
            if p:
                queue.append((p, ROOT, 1))
    seen_paths: set[str] = set()
    while queue and len(nodes) < MAX_PACKAGES:
        path, parent, depth = queue.popleft()
        meta = pkgs.get(path) or {}
        name = name_of(path)
        key = f"{name}@{meta.get('version')}"
        node = nodes.setdefault(key, {"name": name, "version": meta.get("version"), "dev": bool(meta.get("dev")),
                                      "parents": set(), "depth": depth - 1})
        node["parents"].add(parent)
        by_path[path] = key
        if path in seen_paths or depth > MAX_DEPTH:
            continue
        seen_paths.add(path)
        for group in ("dependencies", "optionalDependencies", "peerDependencies"):
            for child in (meta.get(group) or {}):
                p = resolve(path, child)
                if p:
                    queue.append((p, key, depth + 1))
    return nodes, []


# ---------------- vulnerabilities + paths ----------------

def _paths(nodes: dict[str, dict], key: str, label) -> list[list[str]]:
    """Up to MAX_PATHS shortest chains from the app to `key` (labels include versions)."""
    out: list[list[str]] = []
    queue = deque([[key]])
    while queue and len(out) < MAX_PATHS:
        chain = queue.popleft()
        if len(chain) > MAX_DEPTH + 2:
            continue
        for parent in sorted(nodes[chain[-1]]["parents"]):
            if parent == ROOT:
                out.append([ROOT] + [label(k) for k in reversed(chain)])
            elif parent not in chain:
                queue.append(chain + [parent])
    return out


async def analyse(repo: Path, scan_out: dict, py: str) -> dict:
    ecosystem = scan_out.get("ecosystem", "python")
    direct_names = {d["name"] for d in scan_out.get("dependencies", [])}
    if ecosystem == "npm":
        nodes, notes = npm_tree(repo)
        osv_eco, source, approximate = "npm", "package-lock.json", False
        if nodes is None:
            return {"available": False, "source": source, "approximate": False, "total": 0, "vulnerable": 0,
                    "items": [], "notes": notes}
        label = lambda k: f"{nodes[k]['name']} {nodes[k]['version']}"  # noqa: E731
        name_of = lambda k: nodes[k]["name"]  # noqa: E731
    else:
        direct, pins = [], {}
        for d in scan_out.get("dependencies", []):
            if d.get("pinned_version"):
                pins[d["name"]] = d["pinned_version"]
            if d.get("declared") or d.get("latest_version"):
                direct.append({"name": d["name"], "version": d.get("pinned_version"), "dev": d.get("group") == "dev"})
        nodes, notes = await python_tree(direct, pins, py)
        osv_eco, source, approximate = "PyPI", "PyPI metadata", True
        label = lambda k: f"{k} {nodes[k]['version']}"  # noqa: E731
        name_of = lambda k: k  # noqa: E731

    transitive = [k for k, n in nodes.items() if name_of(k) not in direct_names and n.get("version")]
    ids = await registry.osv_batch([(name_of(k), nodes[k]["version"]) for k in transitive], osv_eco)
    if ids is None:
        return {"available": False, "source": source, "approximate": approximate, "total": len(transitive),
                "vulnerable": 0, "items": [], "notes": notes + ["OSV could not be reached: transitive packages not checked"]}
    hits = [k for k in transitive if ids.get((name_of(k), nodes[k]["version"]))]
    details = await asyncio.gather(*(registry.osv_query(name_of(k), nodes[k]["version"], osv_eco) for k in hits))
    items = []
    for k, vulns in zip(hits, details):
        n = nodes[k]
        name = name_of(k)
        vs = []
        for v in vulns or []:
            fixed = sorted({e["fixed"] for a in v.get("affected", []) if normalize((a.get("package") or {}).get("name", "")) == normalize(name)
                            for r in a.get("ranges", []) for e in r.get("events", []) if e.get("fixed")})
            sev = str((v.get("database_specific") or {}).get("severity", "")).lower()
            vs.append({"id": v.get("id"), "summary": (v.get("summary") or v.get("details") or "")[:200],
                       "severity": sev if sev in ("critical", "high", "moderate", "medium", "low") else "unknown",
                       "fixed_in": fixed[-3:], "url": f"https://osv.dev/vulnerability/{v.get('id')}"})
        paths = _paths(nodes, k, label)
        parents = sorted({p[1].rsplit(" ", 1)[0] for p in paths if len(p) > 1})  # the direct dependency at the top
        items.append({"name": name, "version": n["version"], "depth": n.get("depth", 0), "dev": n["dev"],
                      "paths": paths, "via": parents, "vulnerabilities": vs})
    rank = {"critical": 0, "high": 1, "moderate": 2, "medium": 2, "low": 3, "unknown": 4}
    items.sort(key=lambda i: (min((rank[v["severity"]] for v in i["vulnerabilities"]), default=5), i["dev"], i["name"]))
    if approximate:
        notes.append("Python transitive versions are resolved from PyPI metadata (newest release allowed by each "
                     "requirement, pins from the manifests win); a real install may pick other versions")
    unchecked = sorted(name_of(k) for k, n in nodes.items() if name_of(k) not in direct_names and not n.get("version"))
    return {"available": True, "source": source, "approximate": approximate, "total": len(transitive),
            "vulnerable": len(items), "items": items, "unchecked": unchecked, "notes": notes}
