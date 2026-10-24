"use client";

import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Layers,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import {
  createPullRequest,
  getPullRequest,
  previewPullRequest,
  type PullRequestPlan,
  type PullRequestResult,
  type PullRequestRisk,
  type PullRequestSplit,
} from "@/lib/api";
import { apiUrl } from "@/lib/url";

type Tab = "pr" | "local";

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      <pre className="bg-[#17151F] text-[#E8E6F0] rounded-xl px-4 py-3 pr-12 text-xs font-mono overflow-x-auto whitespace-pre">{text}</pre>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20"
        aria-label="Copy"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

const RISK_STYLE = {
  low: { box: "bg-[#EAF6E2] border-[#17151F]", title: "Review risk: low", Icon: ShieldCheck, icon: "text-[#3D7A25]" },
  caution: { box: "bg-[#FDF1D0] border-[#17151F]", title: "Review risk: caution", Icon: AlertTriangle, icon: "text-[#B07D00]" },
  high: { box: "bg-[#FDECEC] border-[#D64545]", title: "Review risk: HIGH", Icon: ShieldAlert, icon: "text-[#D64545]" },
} as const;

/** Why this PR is easy or hard to review safely (computed by the server from the capsule). */
function RiskBanner({ risk }: { risk: PullRequestRisk }) {
  const s = RISK_STYLE[risk.level];
  return (
    <div className={`border-2 rounded-2xl p-4 space-y-2 ${s.box}`} role={risk.level === "low" ? undefined : "alert"}>
      <div className="flex flex-wrap items-center gap-2">
        <s.Icon className={`w-5 h-5 ${s.icon}`} />
        <p className="font-display font-extrabold text-[#17151F]">{s.title}</p>
        <span className="text-xs font-mono text-[#5A5870]">
          {risk.files} files · {risk.lines} changed lines
        </span>
      </div>
      {risk.reasons.length === 0 ? (
        <p className="text-xs text-[#17151F]">Small change, verified in the sandbox. A normal review is enough.</p>
      ) : (
        <ul className="space-y-1">
          {risk.reasons.map((r, i) => (
            <li key={i} className="text-xs text-[#17151F] flex gap-2">
              <span
                className={`shrink-0 self-start whitespace-nowrap mt-0.5 px-1.5 rounded-full text-[9px] font-extrabold uppercase ${
                  r.level === "high" ? "bg-[#D64545] text-white" : "bg-[#F9D56E] text-[#17151F]"
                }`}
              >
                {r.level}
              </span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      {risk.level === "high" && (
        <p className="text-xs font-semibold text-[#D64545]">
          The pull request will be opened as a draft, and you must confirm before it is created.
        </p>
      )}
      {risk.level === "caution" && (
        <p className="text-xs text-[#5A5870]">Opening it as a draft is recommended so it is reviewed before anyone merges it.</p>
      )}
    </div>
  );
}

const LEVEL_CHIP: Record<PullRequestRisk["level"], string> = {
  low: "bg-[#B9E4A1] text-[#17151F]",
  caution: "bg-[#F9D56E] text-[#17151F]",
  high: "bg-[#D64545] text-white",
};

/** The stacked PRs, in merge order, each with its own size and review risk. */
function StackList({ split }: { split: PullRequestSplit }) {
  const [open, setOpen] = useState<number | null>(null);
  const prs = split.prs ?? [];
  return (
    <div className="bg-white border-2 border-[#17151F] rounded-2xl p-4 space-y-2">
      <p className="text-xs text-[#5A5870]">
        Merge in order. Each PR is based on the previous one, so it shows only its own change; when one is merged, GitHub
        retargets the next. {split.note}
      </p>
      <ol className="space-y-2">
        {prs.map((p, i) => {
          const g = split.groups?.[i];
          const r = p.risk;
          return (
            <li key={p.branch} className="border border-[#17151F]/20 rounded-xl p-2.5">
              <button type="button" onClick={() => setOpen(open === i ? null : i)} className="w-full text-left flex items-start gap-2">
                <span className="font-mono text-xs font-bold text-[#5A5870] pt-0.5">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-[#17151F] break-words">{g?.title ?? p.title}</p>
                  <p className="text-[11px] font-mono text-[#5A5870]">
                    {p.files_changed.length} file(s) · +{g?.insertions ?? 0} / -{g?.deletions ?? 0}
                    {g && g.risk_reduction > 0 ? ` · −${g.risk_reduction} risk` : ""}
                    {g?.kind === "quick_wins" ? " · manifest only" : ""}
                  </p>
                </div>
                {r && (
                  <span className={`shrink-0 self-start px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${LEVEL_CHIP[r.level]}`}>
                    {r.level}
                  </span>
                )}
              </button>
              {open === i && r && r.reasons.length > 0 && (
                <ul className="mt-2 pl-6 space-y-1">
                  {r.reasons.map((x, k) => (
                    <li key={k} className="text-[11px] text-[#17151F]">
                      <b className="uppercase text-[9px]">{x.level}</b> {x.text}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Deliver the tested migration: as a GitHub pull request (branch from the analysed commit, files byte-for-byte from
 * the migrated workspace that passed in Docker, capsule as the description) or as a patch to apply locally.
 */
export function PullRequestDialog({ analysisId, repoUrl, onClose }: { analysisId: string; repoUrl: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("pr");
  const [plan, setPlan] = useState<PullRequestPlan | null>(null);
  const [existing, setExisting] = useState<PullRequestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showBody, setShowBody] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [split, setSplit] = useState<PullRequestSplit | null>(null);
  const [mode, setMode] = useState<"single" | "split">("single");
  const splitMode = mode === "split" && !!split?.available;
  // the gate applies to whatever is about to be opened: the single PR, or every part of the stack
  const risks = (splitMode ? (split?.prs ?? []).map((p) => p.risk) : [plan?.risk]).filter(
    (r): r is PullRequestRisk => !!r,
  );
  const risk = risks.find((r) => r.require_confirm) ?? risks.find((r) => r.level === "caution") ?? risks[0];
  const draftForced = !splitMode && !!risk?.force_draft;
  const confirmed = !risk?.require_confirm || confirmText.trim() === risk.confirm_phrase;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prev = await getPullRequest(analysisId);
        if (cancelled) return;
        if (prev) setExisting(prev);
        const { plan: p, split: s } = await previewPullRequest(analysisId);
        if (!cancelled) {
          setPlan(p);
          setSplit(s ?? null);
          if (p.risk && p.risk.level !== "low") {
            setDraft(true); // risky changes start as drafts
            if (s?.available) setMode("split"); // and as small PRs when the change can be split
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message || "Could not prepare the pull request");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [analysisId]);

  // close on Escape
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await createPullRequest(
        analysisId,
        token.trim(),
        draft || draftForced,
        confirmText.trim() || undefined,
        splitMode,
      );
      setExisting(res);
    } catch (e: any) {
      setError(e.message || "GitHub refused the request");
    } finally {
      setToken(""); // never keep the token around
      setSubmitting(false);
    }
  };

  const patchUrl = apiUrl(`/api/analyses/${analysisId}/patch.diff`);
  const repoName = repoUrl.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const localCmd = plan
    ? `git clone ${repoUrl} && cd ${repoName.split("/")[1] ?? "repo"}\n` +
      `git checkout -b ${plan.branch} ${plan.base_commit.slice(0, 12)}\n` +
      `curl -sL "${patchUrl}" | git apply\n` +
      `python -m pip install -r requirements.txt && python -m pytest`
    : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#17151F]/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Deliver the migration"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-[#F5F1E8] border-[3px] border-[#17151F] rounded-[28px] shadow-[8px_8px_0_0_#17151F] overflow-hidden"
      >
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b-[3px] border-[#17151F] bg-white">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#5A5870]">Deliver the tested migration</p>
            <h2 className="font-display font-extrabold text-xl text-[#17151F]">Apply these fixes to {repoName}</h2>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-full hover:bg-[#F5F1E8]" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-2 px-6 pt-4">
          {([
            { k: "pr", label: "Open pull request", Icon: GitPullRequest },
            { k: "local", label: "Apply locally", Icon: Terminal },
          ] as const).map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => setTab(t.k)}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full border-2 border-[#17151F] text-xs font-bold transition ${
                tab === t.k ? "bg-[#F9D56E] shadow-[2px_2px_0_0_#17151F]" : "bg-white"
              }`}
            >
              <t.Icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {loading && (
            <p className="text-sm text-[#5A5870] flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Preparing the change set…
            </p>
          )}
          {error && (
            <p className="text-sm font-semibold text-[#D64545] bg-[#FDECEC] border-2 border-[#D64545] rounded-2xl px-4 py-2">{error}</p>
          )}

          {tab === "pr" && plan && split && !existing && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="How to deliver">
              {([
                {
                  k: "single",
                  title: "One pull request",
                  sub: `${plan.files_changed.length} files · ${plan.risk?.lines ?? 0} changed lines`,
                  Icon: GitPullRequest,
                },
                {
                  k: "split",
                  title: split.available ? `${split.prs?.length ?? 0} smaller stacked PRs` : "Smaller stacked PRs",
                  sub: split.available ? "Quick wins first, then one PR per code rewrite" : split.reason ?? "Not available",
                  Icon: Layers,
                },
              ] as const).map((o) => {
                const disabled = o.k === "split" && !split.available;
                const active = (o.k === "split") === splitMode;
                return (
                  <button
                    key={o.k}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={disabled}
                    onClick={() => setMode(o.k)}
                    className={`text-left rounded-2xl border-2 p-3 transition ${
                      active ? "border-[#17151F] bg-[#F9D56E] shadow-[2px_2px_0_0_#17151F]" : "border-[#17151F]/30 bg-white"
                    } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-bold text-[#17151F]">
                      <o.Icon className="w-4 h-4" /> {o.title}
                    </span>
                    <span className="block text-[11px] text-[#5A5870] mt-0.5">{o.sub}</span>
                  </button>
                );
              })}
            </div>
          )}

          {!existing && !(splitMode && tab === "pr") && plan?.risk && <RiskBanner risk={plan.risk} />}
          {!existing && splitMode && split && tab === "pr" && <StackList split={split} />}

          {plan && !(splitMode && tab === "pr") && (
            <div className="bg-white border-2 border-[#17151F] rounded-2xl p-4 space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                <GitBranch className="w-4 h-4" />
                <span className="bg-[#F5F1E8] rounded px-2 py-0.5">{plan.owner}/{plan.repo}</span>
                <span className="text-[#5A5870]">from analysed commit</span>
                <span className="bg-[#F5F1E8] rounded px-2 py-0.5">{plan.base_commit.slice(0, 10)}</span>
                <span className="text-[#5A5870]">→</span>
                <span className="bg-[#F9D56E] rounded px-2 py-0.5">{plan.branch}</span>
              </div>
              <p className="text-xs text-[#5A5870]">
                {plan.files_changed.length} files, byte-for-byte the migrated workspace that passed the Docker tests. Nothing is
                regenerated. One commit per file:
              </p>
              <ul className="space-y-1">
                {plan.commits.map((c) => (
                  <li key={c.message} className="text-xs font-mono flex gap-2">
                    <span className="text-[#6E56D9]">●</span>
                    <span className="break-all">{c.message.split("\n")[0]}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === "pr" && plan && (
            <>
              {!splitMode && (
              <div className="bg-white border-2 border-[#17151F] rounded-2xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-[#17151F]">{plan.title}</p>
                  <button type="button" onClick={() => setShowBody((v) => !v)} className="text-xs font-bold text-[#6E56D9]">
                    {showBody ? "Hide" : "Preview"} description
                  </button>
                </div>
                <p className="text-xs text-[#5A5870]">
                  The description is the Exit Capsule: verdict, tests before/after, every change with its risk and the model that
                  decided it, compatibility gaps and limitations.
                </p>
                {showBody && (
                  <pre className="bg-[#F5F1E8] rounded-xl p-3 text-[11px] font-mono whitespace-pre-wrap max-h-72 overflow-y-auto">{plan.body}</pre>
                )}
              </div>
              )}

              {existing ? (
                <div className="bg-[#B9E4A1] border-2 border-[#17151F] rounded-2xl p-4 space-y-1">
                  <p className="font-bold text-[#17151F] flex items-center gap-2">
                    <Check className="w-4 h-4" />{" "}
                    {existing.stack && existing.stack.length > 1
                      ? `${existing.stack.length} stacked pull requests are open (merge in order)`
                      : `Pull request #${existing.number} is open`}
                  </p>
                  {existing.stack && existing.stack.length > 1 && (
                    <ol className="space-y-1 list-decimal pl-5">
                      {existing.stack.map((s) => (
                        <li key={s.number} className="text-xs text-[#17151F]">
                          <a href={s.url} target="_blank" rel="noreferrer" className="underline font-semibold">
                            #{s.number}
                          </a>{" "}
                          {s.title}
                          {s.draft ? " (draft)" : ""}
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="text-xs text-[#17151F]">
                    Branch <span className="font-mono">{existing.head}</span>
                    {existing.forked ? " (pushed to your fork — you had no write access to the repository)" : ""} ·{" "}
                    {existing.commits} commits
                  </p>
                  <a href={existing.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-bold text-[#17151F] underline">
                    Open on GitHub <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              ) : (
                <div className="bg-white border-2 border-[#17151F] rounded-2xl p-4 space-y-3">
                  <label className="block text-xs font-bold text-[#17151F]" htmlFor="gh-token">
                    <span className="flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5" /> GitHub token
                    </span>
                  </label>
                  <input
                    id="gh-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="github_pat_…"
                    className="w-full rounded-xl border-2 border-[#17151F] px-3 py-2 font-mono text-sm bg-[#F5F1E8] focus:outline-none focus:ring-2 focus:ring-[#6E56D9]"
                  />
                  <p className="text-[11px] text-[#5A5870] leading-relaxed">
                    Use a fine-grained token with <b>Contents: read &amp; write</b> and <b>Pull requests: read &amp; write</b>.{" "}
                    {splitMode ? (
                      <>
                        Stacked PRs need <b>write access to {plan.owner}/{plan.repo}</b> (each PR is based on the previous
                        one&apos;s branch, which cannot live in a fork); without it, choose <b>One pull request</b>.
                      </>
                    ) : (
                      <>
                        If it cannot push to {plan.owner}/{plan.repo}, DepExit forks the repository to your account and opens the
                        PR from there.
                      </>
                    )}{" "}
                    The token is sent once for this request; it is not stored by DepExit.
                  </p>
                  {risk?.require_confirm && (
                    <div className="space-y-1">
                      <label className="block text-xs font-bold text-[#D64545]" htmlFor="pr-confirm">
                        Type &quot;{risk.confirm_phrase}&quot; to confirm you will review this change before merging
                      </label>
                      <input
                        id="pr-confirm"
                        type="text"
                        autoComplete="off"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder={risk.confirm_phrase}
                        className="w-full rounded-xl border-2 border-[#D64545] px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#D64545]"
                      />
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <label
                      className={`text-xs font-semibold text-[#17151F] flex items-center gap-2 select-none ${
                        draftForced ? "opacity-70" : "cursor-pointer"
                      }`}
                      title={draftForced ? "High review risk: always opened as a draft" : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={draft || draftForced}
                        disabled={draftForced}
                        onChange={(e) => setDraft(e.target.checked)}
                      />{" "}
                      Open as draft{draftForced ? " (required)" : ""}
                      {splitMode && risks.some((r) => r.force_draft) ? " (high-risk parts are always drafts)" : ""}
                    </label>
                    <button
                      type="button"
                      disabled={!token.trim() || submitting || !confirmed}
                      onClick={submit}
                      className="btn-primary text-xs! py-2! px-4! flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitPullRequest className="w-3.5 h-3.5" />}
                      {submitting
                        ? splitMode
                          ? "Opening pull requests…"
                          : "Opening pull request…"
                        : splitMode
                          ? `Open ${split?.prs?.length ?? 0} pull requests`
                          : "Open pull request"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "local" && plan && (
            <div className="bg-white border-2 border-[#17151F] rounded-2xl p-4 space-y-3">
              <p className="text-sm text-[#17151F]">
                Apply the exact patch that passed the sandbox tests on a new branch from the analysed commit, then re-run the tests
                yourself:
              </p>
              <CopyBlock text={localCmd} />
              <p className="text-xs text-[#5A5870]">
                Prefer the editor? The DepExit VS Code extension offers the same change file by file as a quick fix.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
