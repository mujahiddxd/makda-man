"""Split the tested migration into stacked PRs: quick wins first, then one PR per code rewrite by priority."""
import json

from app import split


def dep(name, line):
    return {"name": name, "declared": [{"file": "requirements.txt", "line": line, "spec": ""}]}


def make_job(tmp_path, migrated_req):
    job = tmp_path / "dx_test"
    (job / "repo").mkdir(parents=True)
    (job / "runs" / "migrated" / "repo").mkdir(parents=True)
    (job / "repo" / "requirements.txt").write_text("six==1.0\ntoml==0.10.2\nappdirs==1.4\n", encoding="utf-8")
    (job / "repo" / "a.py").write_text("import toml\n", encoding="utf-8")
    (job / "repo" / "b.py").write_text("import appdirs\n", encoding="utf-8")
    mig = job / "runs" / "migrated" / "repo"
    (mig / "requirements.txt").write_text(migrated_req, encoding="utf-8")
    (mig / "a.py").write_text("import tomllib\n", encoding="utf-8")
    (mig / "b.py").write_text("import platformdirs\n", encoding="utf-8")
    deps = [dep("six", 1), dep("toml", 2), dep("appdirs", 3)]
    proposals = {"six": {"strategy": "remove"}, "toml": {"strategy": "stdlib", "package": "tomllib"},
                 "appdirs": {"strategy": "replace", "package": "platformdirs", "version_spec": ">=4,<5"}}
    mat = {"applied": {n: {"applied": True} for n in proposals},
           "files": [{"path": "a.py", "status": "applied", "deps": ["toml"]},
                     {"path": "b.py", "status": "applied", "deps": ["appdirs"]}],
           "manifest_changes": [{"file": "requirements.txt"}]}
    prios = {"appdirs": {"label": "fix_first", "priority": 80}, "toml": {"label": "plan", "priority": 60},
             "six": {"label": "plan", "priority": 40}}
    return job, deps, proposals, mat, prios


def test_quick_wins_first_then_rewrites_by_priority(tmp_path):
    job, deps, proposals, mat, prios = make_job(tmp_path, "platformdirs>=4,<5\n")
    out = split.plan(job, deps, proposals, mat, ["requirements.txt"], prios, {"six": 55, "toml": 70, "appdirs": 55})
    assert out["available"], out
    groups = out["groups"]
    assert [g["dependencies"] for g in groups] == [["six"], ["appdirs"], ["toml"]]  # fix_first before plan
    assert groups[0]["kind"] == "quick_wins" and [f["path"] for f in groups[0]["files"]] == ["requirements.txt"]
    assert {f["path"] for f in groups[1]["files"]} == {"requirements.txt", "b.py"}
    # each step's manifest is cumulative; step 1 only drops six
    assert (job / "split" / "1" / "requirements.txt").read_text() == "toml==0.10.2\nappdirs==1.4\n"
    assert (job / "split" / "3" / "requirements.txt").read_text() == "platformdirs>=4,<5\n"
    assert groups[0]["title"].startswith("quick wins: remove six")
    assert json.loads((job / "split.json").read_text(encoding="utf-8"))["available"]


def test_split_refused_when_it_cannot_reproduce_the_tested_workspace(tmp_path):
    job, deps, proposals, mat, prios = make_job(tmp_path, "platformdirs>=4,<5\nextra==1\n")  # not what the steps produce
    out = split.plan(job, deps, proposals, mat, ["requirements.txt"], prios, {})
    assert not out["available"] and "reproduce" in out["reason"]
    assert not (job / "split").exists()


def test_files_shared_by_two_dependencies_stay_in_one_pr(tmp_path):
    job, deps, proposals, mat, prios = make_job(tmp_path, "platformdirs>=4,<5\n")
    mat["files"].append({"path": "b.py", "status": "applied", "deps": ["toml", "appdirs"]})
    out = split.plan(job, deps, proposals, mat, ["requirements.txt"], prios, {})
    assert [g["dependencies"] for g in out["groups"]] == [["six"], ["appdirs", "toml"]]
