"""Transitive dependencies: full tree, OSV for every package, and the path that brings each one in."""
import asyncio
import json

from app import registry, transitive


def lock(tmp_path, packages):
    (tmp_path / "package-lock.json").write_text(json.dumps({"lockfileVersion": 3, "packages": packages}), encoding="utf-8")
    return tmp_path


def fake_osv(monkeypatch, vulnerable: dict):
    """vulnerable: {(name, version): [osv record]}"""
    async def batch(pkgs, eco="PyPI"):
        return {p: [v["id"] for v in vulnerable.get(p, [])] for p in pkgs}

    async def query(name, version, eco="PyPI"):
        return vulnerable.get((name, version), [])
    monkeypatch.setattr(registry, "osv_batch", batch)
    monkeypatch.setattr(registry, "osv_query", query)


QS_VULN = {"id": "GHSA-hrpp-h998-j3pp", "summary": "qs prototype pollution", "database_specific": {"severity": "HIGH"},
           "affected": [{"package": {"name": "qs"}, "ranges": [{"events": [{"introduced": "0"}, {"fixed": "6.7.3"}]}]}]}


def test_npm_lockfile_paths_nested_resolution_and_dev(tmp_path, monkeypatch):
    repo = lock(tmp_path, {
        "": {"dependencies": {"express": "^4"}, "devDependencies": {"tool": "1"}},
        "node_modules/express": {"version": "4.17.1", "dependencies": {"body-parser": "1", "qs": "6.7.0"}},
        "node_modules/body-parser": {"version": "1.19.0", "dependencies": {"qs": "6.5.0"}},
        "node_modules/body-parser/node_modules/qs": {"version": "6.5.0"},  # nested copy wins for body-parser
        "node_modules/qs": {"version": "6.7.0"},
        "node_modules/tool": {"version": "1.0.0", "dev": True, "dependencies": {"qs": "6.7.0"}},
    })
    fake_osv(monkeypatch, {("qs", "6.7.0"): [QS_VULN]})
    out = asyncio.run(transitive.analyse(repo, {"ecosystem": "npm", "dependencies": [{"name": "express"}, {"name": "tool"}]}, "3.12"))
    assert out["available"] and out["total"] == 3 and out["vulnerable"] == 1  # body-parser, qs 6.7.0, qs 6.5.0
    item = out["items"][0]
    assert (item["name"], item["version"], item["dev"]) == ("qs", "6.7.0", False)  # also reached at runtime
    assert ["your app", "express 4.17.1", "qs 6.7.0"] in item["paths"]
    assert ["your app", "tool 1.0.0", "qs 6.7.0"] in item["paths"]
    assert set(item["via"]) == {"express", "tool"}
    v = item["vulnerabilities"][0]
    assert v["severity"] == "high" and v["fixed_in"] == ["6.7.3"] and v["url"].endswith("GHSA-hrpp-h998-j3pp")


def test_npm_without_v2_lockfile_is_reported_not_guessed(tmp_path):
    out = asyncio.run(transitive.analyse(tmp_path, {"ecosystem": "npm", "dependencies": []}, "3.12"))
    assert not out["available"] and "No package-lock.json" in out["notes"][0]
    (tmp_path / "package-lock.json").write_text('{"lockfileVersion": 1, "dependencies": {}}')
    out = asyncio.run(transitive.analyse(tmp_path, {"ecosystem": "npm", "dependencies": []}, "3.12"))
    assert not out["available"] and "v1" in out["notes"][0]


def test_python_tree_from_metadata_markers_pins_and_failed_lookups(monkeypatch):
    releases = {
        "requests": {"2.19.0": ["urllib3<1.24,>=1.21.1", "idna<2.8", "pywin32; sys_platform == 'win32'",
                                "PySocks!=1.5.7; extra == 'socks'", "brokenpkg"]},
        "urllib3": {"1.23": [], "1.22": [], "2.0.0": []},
        "idna": {"2.7": [], "3.7": []},
    }

    async def project(name):
        if name == "brokenpkg":
            return None  # registry lookup failed
        r = releases.get(name)
        return {"info": {"version": max(r)}, "releases": {v: [{}] for v in r}} if r else None

    async def release(name, version):
        return {"info": {"requires_dist": releases[name][version]}}
    monkeypatch.setattr(registry, "pypi_project", project)
    monkeypatch.setattr(registry, "pypi_release", release)
    urllib3_vuln = {"id": "PYSEC-2018-32", "summary": "CRLF injection", "affected": [
        {"package": {"name": "urllib3"}, "ranges": [{"events": [{"fixed": "1.24.2"}]}]}]}
    fake_osv(monkeypatch, {("urllib3", "1.23"): [urllib3_vuln]})
    scan = {"ecosystem": "python", "dependencies": [
        {"name": "requests", "pinned_version": "2.19.0", "declared": [{}]},
        {"name": "idna", "pinned_version": "2.7", "declared": [{}]}]}
    out = asyncio.run(transitive.analyse(None, scan, "3.12"))
    names = {i["name"] for i in out["items"]}
    assert out["approximate"] and names == {"urllib3"}
    item = out["items"][0]
    assert item["version"] == "1.23"                                   # newest release allowed by <1.24
    assert item["paths"] == [["your app", "requests 2.19.0", "urllib3 1.23"]]
    assert item["vulnerabilities"][0]["fixed_in"] == ["1.24.2"]
    assert out["total"] == 1                                           # idna is direct; pywin32/PySocks skipped
    assert out["unchecked"] == ["brokenpkg"] and any("brokenpkg" in n for n in out["notes"])
