// DepExit VS Code extension: shows the Exit Capsule from the DepExit API inside the editor.
// - Diagnostics on every usage location and manifest line of an at-risk dependency
// - Hover with risk indicators, Gemma 4 proposal and test gaps
// - Quick fix: replace the file with its migrated version (from the Docker-verified workspace)
const vscode = require("vscode");
const cp = require("child_process");

const LEVELS = ["none", "low", "medium", "high", "critical"];
let diagnostics, statusBar, output;
let state = { id: null, capsule: null, byFile: new Map() };

function cfg() {
  const c = vscode.workspace.getConfiguration("depexit");
  return { api: c.get("apiUrl").replace(/\/$/, ""), minLevel: c.get("minLevel") };
}

async function api(path, asText = false, init = {}) {
  let res;
  try {
    res = await fetch(cfg().api + path, init);
  } catch (e) {
    const err = new Error(`cannot reach the DepExit API at ${cfg().api} (${(e.cause && e.cause.code) || e.message}). ` +
      "Start it with run.ps1 (or `make dev`), or fix the depexit.apiUrl setting.");
    err.unreachable = true;
    throw err;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error.message; } catch { /* plain text */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return asText ? res.text() : res.json();
}

function workspaceRoot() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri : null;
}

// Accepts https://github.com/o/r, github.com/o/r, git@github.com:o/r.git, .../tree/<branch>, trailing .git or "/".
// Returns { url, ref } (ref "" = default branch) or null.
function parseRepo(input) {
  let s = String(input || "").trim().replace(/^git\+/, "");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) s = `github.com/${s}`; // owner/repo shorthand
  const m = s.match(/^(?:(?:https?|ssh):\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|commits?)\/([^?#]+?))?\/?(?:[?#].*)?$/i);
  if (!m) return null;
  return { url: `https://github.com/${m[1]}/${m[2]}`, ref: m[3] ? decodeURIComponent(m[3]) : "" };
}

function gitRemote(root) {
  try {
    const url = cp.execSync("git config --get remote.origin.url", { cwd: root.fsPath, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const r = parseRepo(url);
    return r ? r.url : "";
  } catch { return ""; }
}

const sameRepo = (a, b) => !!a && !!b && a.toLowerCase().replace(/\/$/, "") === b.toLowerCase().replace(/\/$/, "");

// Run git without a shell; resolves with stdout, rejects with git's own error text.
function git(args, cwd, token) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = cp.spawn("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (e) {
      reject(new Error(`git is not available (${e.message}). Install Git and make sure it is on PATH.`));
      return;
    }
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; output.append(String(d)); });
    child.on("error", (e) => reject(new Error(e.code === "ENOENT" ? "git is not installed or not on PATH" : e.message)));
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args[0]} failed: ${err.trim().split("\n").pop() || `exit ${code}`}`))));
    if (token) token.onCancellationRequested(() => child.kill());
  });
}

const severityOf = (level) =>
  level === "critical" || level === "high" ? vscode.DiagnosticSeverity.Error
    : level === "medium" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;

function proposalText(d) {
  const r = d.replacement;
  if (!r) return "no proposal";
  return [r.strategy, r.package, r.version_spec].filter(Boolean).join(" ");
}

function render(capsule) {
  diagnostics.clear();
  state.byFile = new Map();
  const root = workspaceRoot();
  if (!root) return 0;
  const min = LEVELS.indexOf(cfg().minLevel);
  const perFile = new Map();
  const push = (file, line, d, message, code) => {
    const uri = vscode.Uri.joinPath(root, file);
    const key = uri.toString();
    if (!perFile.has(key)) perFile.set(key, { uri, diags: [] });
    const range = new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 500);
    const diag = new vscode.Diagnostic(range, message, severityOf(d.risk.level));
    diag.source = "DepExit";
    diag.code = code;
    perFile.get(key).diags.push(diag);
    if (!state.byFile.has(key)) state.byFile.set(key, []);
    state.byFile.get(key).push({ line: line - 1, dep: d });
  };
  let count = 0;
  for (const d of capsule.dependencies) {
    if (LEVELS.indexOf(d.risk.level) < min) continue;
    count++;
    const codes = d.risk.indicators.map((i) => i.code).join(", ");
    const head = `${d.name} — ${d.risk.level} risk (${d.risk.score})`;
    for (const decl of d.declared) push(decl.file, decl.line, d, `${head}: ${codes}. Proposal: ${proposalText(d)}`, d.name);
    const seen = new Set();
    for (const loc of d.usage.locations) {
      const k = `${loc.file}:${loc.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const special = loc.kind === "private_api" ? " Uses a PRIVATE API." : loc.kind === "monkeypatch" ? " MONKEYPATCHES the library." : "";
      push(loc.file, loc.line, d, `${head}.${special} Proposal: ${proposalText(d)}`, d.name);
    }
  }
  for (const { uri, diags } of perFile.values()) diagnostics.set(uri, diags);
  const s = capsule.summary;
  statusBar.text = `$(shield) DepExit: ${s.at_risk} at risk · ${s.verdict.replace(/_/g, " ")}`;
  statusBar.tooltip = s.headline;
  statusBar.show();
  return count;
}

function hoverFor(d) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`**DepExit · ${d.name}** — \`${d.risk.level}\` (${d.risk.score}/100)\n\n`);
  md.appendMarkdown(`${d.risk.rationale}${d.risk.rationale_provenance === "ai" ? " _(Gemma 4)_" : ""}\n\n`);
  for (const i of d.risk.indicators.slice(0, 6)) md.appendMarkdown(`- **${i.code}**: ${i.detail}\n`);
  if (d.replacement) {
    md.appendMarkdown(`\n**Proposal** ${d.replacement.provenance === "ai" ? "_(Gemma 4)_" : ""}: \`${proposalText(d)}\` — ${d.replacement.rationale}\n`);
  }
  if (d.migration) {
    md.appendMarkdown(`\n**Migration** (${d.migration.applied ? "applied in sandbox" : "not applied"}):\n`);
    d.migration.steps.slice(0, 5).forEach((s, n) => md.appendMarkdown(`${n + 1}. ${s}\n`));
  }
  const gaps = d.compatibility_gaps || [];
  if (gaps.length) {
    md.appendMarkdown(`\n**Test gaps:**\n`);
    for (const g of gaps.slice(0, 4)) md.appendMarkdown(`- \`${g.test_id || "install"}\` ${g.baseline} → ${g.migrated} (**${g.change}**): ${g.explanation}\n`);
  } else if (d.test_results && d.test_results.status !== "not_run") {
    md.appendMarkdown(`\n**Tests:** ${d.test_results.status} on the migrated workspace.\n`);
  }
  return md;
}

// Why a job failed, in words: the job error, else the failed stages with their errors.
function failureReason(job) {
  const failed = (job.stages || []).filter((s) => s.status === "failed");
  const parts = failed.map((s) => `${s.label}: ${(s.error || "failed").replace(/\s+/g, " ").slice(0, 300)}`);
  let msg = (job.error || parts.join(" | ") || "the analysis failed without an error message (see the backend log)").replace(/[.\s]+$/, "");
  if (/server restarted/i.test(msg)) msg += ". The DepExit API was restarted during the run; start the analysis again";
  else if (/AI service|:8001/i.test(msg)) msg += ". Is the AI service running (run.ps1 starts it on :8001)?";
  else if (/clone/i.test(msg) && /not found|could not read|repository/i.test(msg)) msg += ". Check that the repository exists and is public";
  return /[.?]$/.test(msg) ? msg : msg + ".";
}

async function preflight() {
  const h = await api("/api/health");
  const problems = [];
  if (h.ai_service === false) problems.push("the AI service is not running (AI stages will fail)");
  if (h.docker === false) problems.push("Docker is not running (tests cannot run in the sandbox)");
  if (!problems.length) return true;
  const pick = await vscode.window.showWarningMessage(`DepExit: ${problems.join("; ")}.`, { modal: true }, "Analyse anyway");
  return pick === "Analyse anyway";
}

async function loadAnalysis(id) {
  let capsule;
  try {
    capsule = await api(`/api/analyses/${id}/capsule`);
  } catch (e) {
    if (e.status !== 404) throw e;
    const job = await api(`/api/analyses/${id}`).catch(() => null);
    if (!job) throw new Error(`analysis ${id} does not exist on ${cfg().api}`);
    if (job.status === "failed") throw new Error(`analysis ${id} failed: ${failureReason(job)}`);
    throw new Error(`analysis ${id} is still ${job.status}; try again when it has finished`);
  }
  state = { ...state, id, capsule };
  const n = render(capsule);
  output.appendLine(`Loaded capsule ${id}: ${n} at-risk dependencies shown.`);
  const repoUrl = capsule.target && capsule.target.repo_url;
  const root = workspaceRoot();
  if (repoUrl && !(root && sameRepo(gitRemote(root), repoUrl))) {
    vscode.window.showWarningMessage(
      `DepExit: the open folder is not ${repoUrl}, so the warnings cannot point at its files. Clone it to see them in the code.`,
      "Clone & Open").then((pick) => { if (pick) vscode.commands.executeCommand("depexit.clone", id); });
  }
  vscode.window.showInformationMessage(`DepExit: ${capsule.summary.headline}`, "Open Capsule", "Open Patch").then((pick) => {
    if (pick === "Open Capsule") vscode.commands.executeCommand("depexit.openCapsule");
    if (pick === "Open Patch") vscode.commands.executeCommand("depexit.openPatch");
  });
}

async function analyze() {
  const root = workspaceRoot();
  const input = await vscode.window.showInputBox({
    prompt: "GitHub repository to analyse: DepExit clones it on the server, scans it and runs its tests in Docker",
    placeHolder: "https://github.com/owner/repo  (github.com/owner/repo, git@github.com:owner/repo.git and /tree/<branch> work too)",
    value: (root && gitRemote(root)) || "https://github.com/rishrek/LinkWatch",
    validateInput: (v) => (parseRepo(v) ? null : "Enter a GitHub repository, e.g. https://github.com/owner/repo"),
  });
  if (!input) return;
  const repo = parseRepo(input);
  if (!(await preflight())) return;
  const created = await api("/api/analyses", false, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo_url: repo.url, ...(repo.ref ? { ref: repo.ref } : {}) }),
  });
  output.appendLine(`Started analysis ${created.id} of ${repo.url}${repo.ref ? ` @ ${repo.ref}` : ""}`);
  const job = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `DepExit: ${repo.url.replace("https://github.com/", "")}`, cancellable: true },
    async (progress, token) => {
      let last = "";
      for (; ;) {
        if (token.isCancellationRequested) {
          vscode.window.showInformationMessage(`DepExit: stopped watching ${created.id}; it keeps running. Load it later with "DepExit: Load Analysis by ID".`);
          return null;
        }
        const j = await api(`/api/analyses/${created.id}`);
        const running = j.stages.filter((s) => s.status === "running").map((s) => s.label).join(" · ");
        if (running && running !== last) { progress.report({ message: running }); last = running; }
        if (["completed", "completed_with_errors", "failed"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 2000));
      }
    });
  if (!job) return;
  if (job.status === "failed") {
    output.appendLine(`Analysis ${created.id} failed: ${failureReason(job)}`);
    output.show(true);
    throw new Error(`analysis failed: ${failureReason(job)}`);
  }
  if (job.status === "completed_with_errors") {
    vscode.window.showWarningMessage(`DepExit: finished with errors: ${failureReason(job)}`);
  }
  if (root && sameRepo(gitRemote(root), repo.url)) {
    await loadAnalysis(created.id); // the open folder is the analysed repo: show the results here
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `DepExit: analysis of ${repo.url} is ready. Clone the repository at the analysed commit to see the results in its code?`,
    "Clone & Open", "Just load results");
  if (pick === "Clone & Open") await cloneAndOpen(created.id);
  else if (pick) await loadAnalysis(created.id);
}

// ---- Clone the analysed repository locally (exact analysed commit) and open it with the results ----
const PENDING_KEY = "depexit.pendingLoads"; // folder path -> analysis id, picked up when that folder opens
let extContext;

async function cloneAndOpen(id) {
  if (!id) id = state.id;
  if (!id) throw new Error("load an analysis first (DepExit: Load Analysis by ID)");
  const job = await api(`/api/analyses/${id}`);
  const repo = parseRepo(job.repo_url);
  if (!repo) throw new Error(`${job.repo_url} is not a GitHub repository`);
  const name = repo.url.split("/").pop();
  const parent = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    openLabel: `Clone ${name} here`, title: `DepExit: choose where to clone ${repo.url}`,
  });
  if (!parent || !parent.length) return;
  let target = vscode.Uri.joinPath(parent[0], name);
  const exists = await vscode.workspace.fs.stat(target).then(() => true, () => false);
  if (exists) {
    if (sameRepo(gitRemote(target), repo.url)) {
      const reuse = await vscode.window.showInformationMessage(`${target.fsPath} is already a clone of ${repo.url}.`, { modal: true }, "Use it");
      if (reuse !== "Use it") return;
    } else {
      target = vscode.Uri.joinPath(parent[0], `${name}-${id}`);
      if (await vscode.workspace.fs.stat(target).then(() => true, () => false)) throw new Error(`${target.fsPath} already exists`);
    }
  }
  const fresh = !exists || !sameRepo(gitRemote(target), repo.url);
  const branch = `depexit/${id}`;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `DepExit: cloning ${repo.url}`, cancellable: true },
    async (progress, token) => {
      if (fresh) {
        progress.report({ message: "git clone…" });
        await git(["clone", "--no-tags", repo.url, target.fsPath], parent[0].fsPath, token);
      } else {
        progress.report({ message: "git fetch…" });
        await git(["fetch", "--no-tags", "origin"], target.fsPath, token);
      }
      if (job.commit) {
        progress.report({ message: `checking out the analysed commit ${job.commit.slice(0, 10)}…` });
        try {
          await git(["checkout", "-B", branch, job.commit], target.fsPath, token);
        } catch (e) { // the commit can be missing from a fork/branch that moved: fetch it explicitly
          await git(["fetch", "origin", job.commit], target.fsPath, token);
          await git(["checkout", "-B", branch, job.commit], target.fsPath, token);
        }
      }
    });
  output.appendLine(`Cloned ${repo.url} to ${target.fsPath}${job.commit ? ` at ${job.commit.slice(0, 10)} (branch ${branch})` : ""}`);
  const pending = extContext.globalState.get(PENDING_KEY, {});
  pending[target.fsPath.toLowerCase()] = id;
  await extContext.globalState.update(PENDING_KEY, pending);
  const where = await vscode.window.showInformationMessage(
    `DepExit: cloned to ${target.fsPath}. Open it to see the results in the code.`, "Open Here", "Open in New Window");
  if (!where) return;
  await vscode.commands.executeCommand("vscode.openFolder", target, { forceNewWindow: where === "Open in New Window" });
}

// When a folder opens that DepExit just cloned, load its analysis automatically.
async function loadPending() {
  const root = workspaceRoot();
  if (!root || !extContext) return;
  const pending = extContext.globalState.get(PENDING_KEY, {});
  const key = root.fsPath.toLowerCase();
  const id = pending[key];
  if (!id) return;
  delete pending[key];
  await extContext.globalState.update(PENDING_KEY, pending);
  await loadAnalysis(id);
}

async function openText(path, language) {
  const text = await api(`/api/analyses/${state.id}${path}`, true);
  const doc = await vscode.workspace.openTextDocument({ content: text, language });
  await vscode.window.showTextDocument(doc, { preview: true });
  return doc;
}

class QuickFix {
  provideCodeActions(document, range, context) {
    const ours = context.diagnostics.filter((d) => d.source === "DepExit");
    if (!ours.length || !state.id) return [];
    const rel = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
    const fix = new vscode.CodeAction("DepExit: replace file with its migrated version", vscode.CodeActionKind.QuickFix);
    fix.command = { command: "depexit.applyFile", title: "Apply migration", arguments: [document.uri, rel] };
    fix.diagnostics = ours;
    const show = new vscode.CodeAction("DepExit: open Exit Capsule", vscode.CodeActionKind.QuickFix);
    show.command = { command: "depexit.openCapsule", title: "Open capsule" };
    const all = new vscode.CodeAction("DepExit: apply migration to ALL files", vscode.CodeActionKind.QuickFix);
    all.command = { command: "depexit.applyAll", title: "Apply all migrations" };
    all.diagnostics = ours;
    return [fix, all, show];
  }
}

// ---- Applying the migration to the open workspace ----
// Every file is checked before it is touched: the local copy must still match the version DepExit analysed,
// otherwise it holds edits (or another commit) that a blind overwrite would destroy.
const eolFree = (s) => String(s).replace(/\r\n/g, "\n");
const encPath = (rel) => rel.split("/").map(encodeURIComponent).join("/");

async function localText(uri) {
  const open = vscode.workspace.textDocuments && vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText(); // includes unsaved edits
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch { return null; } // missing
}

// Refuse to write another repository's migration into this folder.
async function guardWorkspace() {
  if (!state.id || !state.capsule) throw new Error("load an analysis first (DepExit: Load Analysis by ID)");
  const root = workspaceRoot();
  if (!root) throw new Error("open the analysed repository as a workspace folder first (or use DepExit: Clone Analysed Repository & Open)");
  const want = state.capsule.target && state.capsule.target.repo_url;
  const have = gitRemote(root);
  if (want && have && !sameRepo(have, want)) {
    throw new Error(`this folder is ${have}, but the analysis is of ${want}. Use "DepExit: Clone Analysed Repository & Open" to get the right code`);
  }
  if (want && !have) {
    const go = await vscode.window.showWarningMessage(
      `DepExit: this folder has no GitHub remote, so it cannot be confirmed to be ${want}. Every file is still checked against the analysed version before it changes.`,
      { modal: true }, "Continue");
    if (go !== "Continue") return null;
  }
  return root;
}

// The sandbox result decides how loudly we warn: an unverified migration must never look safe.
async function confirmVerification(count) {
  const s = state.capsule.summary || {};
  const m = s.migrated || {};
  const verified = m.status === "passed" && s.verdict !== "blocked";
  if (verified) return true;
  const why = m.status === "install_failed" ? "the migrated project did not install in the sandbox"
    : m.status === "network_error" ? "the sandbox could not download packages (network problem), so no tests ran"
    : m.status === "no_tests" ? "the project has no tests, so nothing was checked by execution"
    : m.status === "tests_failed" ? `tests failed after the migration (${m.passed}/${m.total} passed; ${(s.baseline || {}).passed}/${(s.baseline || {}).total} before)`
      : m.status ? `the sandbox run ended with "${m.status}"` : "it was not run in the sandbox";
  const go = await vscode.window.showWarningMessage(
    `DepExit: this migration is NOT verified: ${why}${s.verdict === "blocked" ? " and the verdict is BLOCKED" : ""}. Apply ${count} file(s) anyway?`,
    { modal: true }, "Apply Anyway");
  return go === "Apply Anyway";
}

// Classify every changed file: ready | already | conflict | missing.
async function planFiles(root, only) {
  const listing = await api(`/api/analyses/${state.id}/files`);
  const changed = listing.files.filter((f) => ["modified", "added", "removed"].includes(f.status) && (!only || f.path === only));
  return Promise.all(changed.map(async (f) => {
    const uri = vscode.Uri.joinPath(root, ...f.path.split("/"));
    const [orig, mig, local] = await Promise.all([
      f.status === "added" ? null : api(`/api/analyses/${state.id}/original/${encPath(f.path)}`, true),
      f.status === "removed" ? null : api(`/api/analyses/${state.id}/migrated/${encPath(f.path)}`, true),
      localText(uri),
    ]);
    let kind;
    if (f.status === "removed") kind = local === null ? "already" : eolFree(local) === eolFree(orig) ? "ready" : "conflict";
    else if (local !== null && eolFree(local) === eolFree(mig)) kind = "already";
    else if (f.status === "added") kind = local === null ? "ready" : "conflict";
    else if (local === null) kind = "missing";
    else kind = eolFree(local) === eolFree(orig) ? "ready" : "conflict";
    return { ...f, uri, orig, mig, local, kind };
  }));
}

function describe(p) {
  return {
    ready: p.status === "removed" ? "will be deleted" : p.status === "added" ? "new file" : "unchanged since the analysis: safe to replace",
    conflict: p.status === "removed" ? "you changed it: deleting it loses your edits" : "your copy differs from the analysed version: replacing it loses those edits",
  }[p.kind];
}

// One WorkspaceEdit for everything, then save exactly the files we touched.
async function writeFiles(picks) {
  const edit = new vscode.WorkspaceEdit();
  for (const p of picks) {
    if (p.status === "removed") edit.deleteFile(p.uri, { ignoreIfNotExists: true });
    else if (p.local === null) edit.createFile(p.uri, { overwrite: false, ignoreIfExists: false, contents: Buffer.from(p.mig, "utf8") });
    else {
      const doc = await vscode.workspace.openTextDocument(p.uri);
      // inserted text is normalised to the document's line endings by VS Code
      edit.replace(p.uri, new vscode.Range(0, 0, doc.lineCount, 0), p.mig);
    }
  }
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code rejected the edit; nothing was changed");
  const saved = [];
  for (const p of picks) {
    if (p.status === "removed" || p.local === null) { saved.push(p.path); continue; } // created/deleted on disk already
    const doc = await vscode.workspace.openTextDocument(p.uri);
    if (await doc.save()) saved.push(p.path);
  }
  return saved;
}

async function applyFile(uri, rel) {
  const root = await guardWorkspace();
  if (!root) return;
  rel = rel || vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  const [p] = await planFiles(root, rel);
  if (!p) {
    vscode.window.showInformationMessage(`DepExit: the migration does not change ${rel}.`);
    return;
  }
  if (p.kind === "already") {
    vscode.window.showInformationMessage(`DepExit: ${rel} already has the migrated version.`);
    return;
  }
  if (p.kind === "missing") throw new Error(`${rel} does not exist in this folder (was it moved or deleted?)`);
  if (p.status !== "removed") {
    const migrated = await vscode.workspace.openTextDocument({ content: p.mig, language: (await vscode.workspace.openTextDocument(uri)).languageId });
    await vscode.commands.executeCommand("vscode.diff", uri, migrated.uri, `${rel} ↔ DepExit migrated`);
  }
  if (!(await confirmVerification(1))) return;
  const ok = await vscode.window.showWarningMessage(
    p.kind === "conflict"
      ? `${rel} has changed since DepExit analysed it. Replacing it with the migrated version DISCARDS your changes to this file. Continue?`
      : `Apply DepExit's migrated version of ${rel}? The file is saved; undo with git (git checkout -- ${rel}).`,
    { modal: true }, p.kind === "conflict" ? "Discard My Changes and Apply" : "Apply");
  if (!ok) return;
  await writeFiles([p]);
  vscode.window.showInformationMessage(`DepExit: applied and saved ${rel}. Run your tests to confirm.`);
}

async function applyAll() {
  const root = await guardWorkspace();
  if (!root) return;
  const plan = await planFiles(root);
  const already = plan.filter((p) => p.kind === "already");
  const missing = plan.filter((p) => p.kind === "missing");
  const todo = plan.filter((p) => p.kind === "ready" || p.kind === "conflict");
  for (const p of missing) output.appendLine(`skip ${p.path}: not found in this folder`);
  if (!todo.length) {
    vscode.window.showInformationMessage(plan.length && already.length === plan.length
      ? `DepExit: all ${plan.length} migrated file(s) are already applied.`
      : missing.length ? `DepExit: nothing to apply; ${missing.length} file(s) are missing from this folder (see the DepExit output).`
        : "DepExit: nothing to migrate.");
    return;
  }
  const conflicts = todo.filter((p) => p.kind === "conflict").length;
  const picks = await vscode.window.showQuickPick(
    todo.map((p) => ({
      label: (p.kind === "conflict" ? "$(warning) " : "") + p.path,
      description: p.status,
      detail: describe(p),
      picked: p.kind === "ready", // never overwrite local edits unless ticked on purpose
      p,
    })),
    {
      canPickMany: true,
      title: `DepExit: apply the migration to ${todo.length} file(s)` +
        (conflicts ? ` · ${conflicts} changed locally (unticked)` : "") +
        (already.length ? ` · ${already.length} already applied` : "") + (missing.length ? ` · ${missing.length} missing` : ""),
    });
  if (!picks || !picks.length) return;
  if (!(await confirmVerification(picks.length))) return;
  const overwrite = picks.filter((x) => x.p.kind === "conflict").length;
  const ok = await vscode.window.showWarningMessage(
    `Apply DepExit's migration to ${picks.length} file(s) and save them?` +
    (overwrite ? ` ${overwrite} of them have local changes that will be DISCARDED.` : "") +
    " Undo with git (git checkout -- . / git clean for new files).",
    { modal: true }, "Apply All");
  if (ok !== "Apply All") return;
  const saved = await writeFiles(picks.map((x) => x.p));
  output.appendLine(`Applied migration ${state.id} to: ${saved.join(", ")}`);
  const next = await vscode.window.showInformationMessage(
    `DepExit: applied and saved ${saved.length} file(s)` + (missing.length ? ` (${missing.length} missing, skipped)` : "") +
    ". Install the new dependencies and run your tests.", "Show Changes");
  if (next === "Show Changes") vscode.commands.executeCommand("workbench.view.scm");
}

// ---- Sign in with GitHub ----
// The API runs the OAuth flow in the browser, then redirects to <scheme>://depexit.depexit/auth?token=<DepExit JWT>,
// which VS Code routes to the UriHandler below. The token is kept in SecretStorage (never in settings or files).
const SECRET_KEY = "depexit.token";

async function whoAmI(token) {
  return api("/api/auth/me", false, { headers: { Authorization: `Bearer ${token}` } });
}

async function signIn() {
  const scheme = vscode.env.uriScheme || "vscode";
  const url = `${cfg().api}/api/auth/github/login?client=${encodeURIComponent(scheme)}`;
  if (!(await vscode.env.openExternal(vscode.Uri.parse(url)))) throw new Error("could not open the browser");
  vscode.window.showInformationMessage("DepExit: finish signing in with GitHub in your browser.");
}

async function acceptToken(context, token) {
  const me = await whoAmI(token); // verify before storing
  await context.secrets.store(SECRET_KEY, token);
  const who = me.github_login ? `@${me.github_login}` : me.email;
  output.appendLine(`Signed in as ${who}`);
  vscode.window.showInformationMessage(`DepExit: signed in as ${who}.`);
}

function activate(context) {
  extContext = context;
  diagnostics = vscode.languages.createDiagnosticCollection("depexit");
  output = vscode.window.createOutputChannel("DepExit");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "depexit.openCapsule";
  const wrap = (fn) => async (...args) => {
    try { await fn(...args); } catch (e) { vscode.window.showErrorMessage(`DepExit: ${e.message}`); output.appendLine(String(e.stack || e)); }
  };
  context.subscriptions.push(
    diagnostics, output, statusBar,
    vscode.commands.registerCommand("depexit.signIn", wrap(signIn)),
    vscode.commands.registerCommand("depexit.signOut", wrap(async () => {
      await context.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage("DepExit: signed out.");
    })),
    vscode.window.registerUriHandler({
      handleUri: wrap(async (uri) => {
        if (uri.path !== "/auth") return;
        const token = new URLSearchParams(uri.query).get("token");
        if (!token) throw new Error("sign-in returned no token");
        await acceptToken(context, token);
      }),
    }),
    vscode.commands.registerCommand("depexit.analyze", wrap(analyze)),
    vscode.commands.registerCommand("depexit.clone", wrap(cloneAndOpen)),
    vscode.commands.registerCommand("depexit.load", wrap(async () => {
      let items = [];
      try {
        items = (await api("/api/analyses")).items
          .filter((i) => i.status === "completed" || i.status === "completed_with_errors")
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      } catch (e) {
        if (e.unreachable) throw e;
      }
      const pick = items.length
        ? await vscode.window.showQuickPick(items.map((i) => ({
          label: i.id, description: i.repo_url,
          detail: `${i.status.replace(/_/g, " ")} · ${new Date(i.created_at).toLocaleString()}` +
            (i.summary ? ` · ${i.summary.at_risk} of ${i.summary.dependencies_total} at risk` : ""),
        })), { title: "DepExit: finished analyses" })
        : { label: await vscode.window.showInputBox({ prompt: "Analysis ID (dx_...)" }) };
      if (pick && pick.label) await loadAnalysis(pick.label);
    })),
    vscode.commands.registerCommand("depexit.openCapsule", wrap(async () => {
      if (!state.id) throw new Error("load an analysis first (DepExit: Load Analysis by ID)");
      const doc = await openText("/capsule.md", "markdown");
      await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
    })),
    vscode.commands.registerCommand("depexit.openPatch", wrap(async () => {
      if (!state.id) throw new Error("load an analysis first");
      await openText("/patch.diff", "diff");
    })),
    vscode.commands.registerCommand("depexit.applyFile", wrap(applyFile)),
    vscode.commands.registerCommand("depexit.applyAll", wrap(applyAll)),
    vscode.commands.registerCommand("depexit.clear", () => { diagnostics.clear(); statusBar.hide(); state.id = null; }),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new QuickFix(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerHoverProvider({ scheme: "file" }, {
      provideHover(document, position) {
        const hits = (state.byFile.get(document.uri.toString()) || []).filter((h) => h.line === position.line);
        if (!hits.length) return null;
        const uniq = [...new Map(hits.map((h) => [h.dep.name, h.dep])).values()];
        return new vscode.Hover(uniq.map(hoverFor));
      },
    }),
  );
  wrap(loadPending)();
}

function deactivate() { }

module.exports = { activate, deactivate, _test: { parseRepo, failureReason, sameRepo } };
