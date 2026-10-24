"use client";

import React, { useState } from "react";
import type { Dependency, RiskChange, RiskLevel, RiskReduction } from "@/lib/types";
import { RiskBadge } from "./Shared";
import { CodeChip } from "./ui/Base";
import { ArrowRight, TrendingDown, TrendingUp, Minus, ChevronRight } from "lucide-react";

const LEVEL_COLOR: Record<RiskLevel, string> = {
  critical: "#D64545",
  high: "#F2A58B",
  medium: "#F9D56E",
  low: "#A8CCF4",
  none: "#B9E4A1",
};

const OUTCOME_TEXT: Record<RiskChange["outcome"], string> = {
  eliminated: "Risk eliminated",
  reduced: "Risk reduced",
  unchanged: "No change",
  increased: "Risk increased",
};

/** "−70" / "+5" / "±0" chip for a before → after change. */
export function DeltaChip({ reduction, pct }: { reduction: number; pct?: number }) {
  const cls =
    reduction > 0
      ? "bg-[#B9E4A1] text-[#17151F] border-[#17151F]/40"
      : reduction < 0
        ? "bg-[#FDECEC] text-[#D64545] border-[#D64545]"
        : "bg-[#F5F1E8] text-[#5A5870] border-[#17151F]/20";
  const Icon = reduction > 0 ? TrendingDown : reduction < 0 ? TrendingUp : Minus;
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[11px] font-bold px-2 py-0.5 rounded-full border ${cls}`}>
      <Icon className="w-3 h-3" />
      {reduction > 0 ? `−${reduction}` : reduction < 0 ? `+${-reduction}` : "±0"}
      {pct !== undefined && reduction !== 0 && <span className="font-semibold opacity-70">({Math.abs(pct)}%)</span>}
    </span>
  );
}

/** Compact table cell: "90 → 20  −70". */
export function RiskDelta({ rc }: { rc?: RiskChange | null }) {
  if (!rc) return <span className="text-xs text-[#5A5870]">—</span>;
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap" title={rc.explanation}>
      <span className="font-mono text-xs text-[#5A5870]">{rc.before.score}</span>
      <ArrowRight className="w-3 h-3 text-[#5A5870]" />
      <RiskBadge level={rc.after.level} score={rc.after.score} />
      <DeltaChip reduction={rc.reduction} />
    </div>
  );
}

function Stat({ label, before, after, suffix }: { label: string; before: number; after: number; suffix?: string }) {
  return (
    <div className="bg-[#F5F1E8] border-2 border-[#17151F] rounded-2xl p-4">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[#5A5870]">{label}</p>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="font-display font-extrabold text-2xl text-[#5A5870] line-through decoration-2">{before}</span>
        <ArrowRight className="w-4 h-4 text-[#17151F] self-center" />
        <span className="font-display font-extrabold text-3xl text-[#17151F]">{after}</span>
        {suffix && <span className="text-xs font-semibold text-[#5A5870]">{suffix}</span>}
      </div>
    </div>
  );
}

function Bar({ score, level, faded }: { score: number; level: RiskLevel; faded?: boolean }) {
  return (
    <div className="h-2.5 w-full bg-[#17151F]/5 rounded-full overflow-hidden border border-[#17151F]/15">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.max(score, score > 0 ? 2 : 0)}%`, background: LEVEL_COLOR[level], opacity: faded ? 0.45 : 1 }}
      />
    </div>
  );
}

function actionLabel(dep: Dependency): string {
  const r = dep.replacement;
  const rc = dep.risk_change;
  if (!r) return "no proposal";
  const target = rc?.after.package ? `${rc.after.package}${rc.after.version ? " " + rc.after.version : ""}` : r.package || "";
  switch (r.strategy) {
    case "replace":
      return `replace → ${target}`;
    case "upgrade":
      return `upgrade → ${rc?.after.version || r.version_spec || "latest"}`;
    case "declare":
      return `declare ${target}`;
    case "stdlib":
      return `stdlib → ${r.package || ""}`;
    default:
      return r.strategy;
  }
}

/** Project-wide "risk before → after" panel with one row per dependency. */
export function RiskReductionPanel({
  summary,
  dependencies,
  onSelectDependency,
}: {
  summary: RiskReduction;
  dependencies: Dependency[];
  onSelectDependency?: (dep: Dependency) => void;
}) {
  const [changedOnly, setChangedOnly] = useState(true);
  const rows = dependencies
    .filter((d) => d.risk_change && (!changedOnly || d.risk_change.reduction !== 0))
    .sort((a, b) => (b.risk_change!.reduction - a.risk_change!.reduction) || (b.risk.score - a.risk.score));

  return (
    <div className="bg-white border-[3px] border-[#17151F] rounded-[28px] shadow-[6px_6px_0_0_#17151F] p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-3 border-b border-[#17151F]/15">
        <div>
          <h3 className="font-display font-extrabold text-2xl text-[#17151F]">Risk before → after</h3>
          <p className="text-sm text-[#5A5870]">
            What each proposed change installs, scored with the same deterministic engine as the scan (PyPI / npm, OSV
            advisories, maintenance, deprecation, Python support).
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 shrink-0">
          {summary.eliminated > 0 && (
            <span className="text-[11px] font-bold bg-[#B9E4A1] px-2 py-0.5 rounded-full border border-[#17151F]/30">
              {summary.eliminated} eliminated
            </span>
          )}
          {summary.reduced > 0 && (
            <span className="text-[11px] font-bold bg-[#A8CCF4] px-2 py-0.5 rounded-full border border-[#17151F]/30">
              {summary.reduced} reduced
            </span>
          )}
          {summary.unchanged > 0 && (
            <span className="text-[11px] font-bold bg-[#F5F1E8] px-2 py-0.5 rounded-full border border-[#17151F]/30">
              {summary.unchanged} unchanged
            </span>
          )}
          {summary.increased > 0 && (
            <span className="text-[11px] font-bold bg-[#FDECEC] text-[#D64545] px-2 py-0.5 rounded-full border border-[#D64545]">
              {summary.increased} increased
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="relative">
          <Stat label="Total dependency risk" before={summary.total_before} after={summary.total_after} />
          <div className="absolute top-3 right-3">
            <DeltaChip reduction={summary.reduced_by} pct={summary.reduced_pct} />
          </div>
        </div>
        <Stat label="At-risk dependencies" before={summary.at_risk_before} after={summary.at_risk_after} />
        <Stat label="Highest single risk" before={summary.max_before} after={summary.max_after} suffix="/ 100" />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold uppercase tracking-wider text-[#5A5870]">Per dependency</p>
          <div className="flex gap-1">
            {[true, false].map((v) => (
              <button
                key={String(v)}
                type="button"
                onClick={() => setChangedOnly(v)}
                className={`px-3 py-1 text-xs font-bold rounded-full transition cursor-pointer ${
                  changedOnly === v
                    ? "bg-[#17151F] text-white"
                    : "bg-[#F5F1E8] text-[#17151F] border border-[#17151F]/20 hover:bg-[#F9D56E]"
                }`}
              >
                {v ? "Changed" : "All"}
              </button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-[#5A5870] italic">No proposal changes the risk score.</p>
        ) : (
          <div className="divide-y divide-[#17151F]/10">
            {rows.map((d) => {
              const rc = d.risk_change!;
              return (
                <button
                  key={d.name}
                  type="button"
                  onClick={() => onSelectDependency?.(d)}
                  className="group w-full text-left py-3 grid grid-cols-1 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_auto] gap-2 md:gap-4 items-center hover:bg-[#FDF1D0]/50 rounded-lg px-2 cursor-pointer"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-bold text-[#17151F] truncate">{d.name}</p>
                    <p className="text-xs text-[#5A5870] truncate">{actionLabel(d)}</p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase w-11 text-[#5A5870]">before</span>
                      <Bar score={rc.before.score} level={rc.before.level} faded />
                      <span className="font-mono text-xs w-7 text-right text-[#5A5870]">{rc.before.score}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase w-11 text-[#17151F]">after</span>
                      <Bar score={rc.after.score} level={rc.after.level} />
                      <span className="font-mono text-xs w-7 text-right font-bold">{rc.after.score}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 md:justify-end">
                    <DeltaChip reduction={rc.reduction} pct={rc.reduction_pct} />
                    <ChevronRight className="w-4 h-4 text-[#5A5870] group-hover:translate-x-1 transition" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Detail view: how the change lowers (or doesn't lower) the risk, and why this package was chosen. */
export function RiskChangeDetail({ rc }: { rc: RiskChange }) {
  const groups: { title: string; items: RiskChange["resolved"]; sign: string; cls: string }[] = [
    { title: "Fixed by this change", items: rc.resolved, sign: "−", cls: "bg-[#EAF6E2] border-[#17151F]/20" },
    { title: "Still present", items: rc.remaining, sign: "", cls: "bg-[#FDF1D0] border-[#17151F]/20" },
    { title: "New with this change", items: rc.introduced, sign: "+", cls: "bg-[#FDECEC] border-[#D64545]/40" },
  ];
  return (
    <div className="space-y-3 border-2 border-[#17151F] rounded-2xl p-4 bg-white">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-[#5A5870] mr-1">Risk</span>
        <RiskBadge level={rc.before.level} score={rc.before.score} />
        <ArrowRight className="w-4 h-4" />
        <RiskBadge level={rc.after.level} score={rc.after.score} />
        <DeltaChip reduction={rc.reduction} pct={rc.reduction_pct} />
        <span className="text-xs font-bold text-[#17151F] ml-auto">{OUTCOME_TEXT[rc.outcome]}</span>
      </div>
      <p className="text-sm text-[#17151F]">{rc.explanation}</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {groups.map((g) => (
          <div key={g.title} className={`rounded-xl border p-3 ${g.cls}`}>
            <p className="text-[11px] font-bold uppercase tracking-wider text-[#5A5870] mb-1.5">{g.title}</p>
            {g.items.length === 0 ? (
              <p className="text-xs text-[#5A5870] italic">none</p>
            ) : (
              <ul className="space-y-1.5">
                {g.items.map((it) => (
                  <li key={it.code} className="text-xs" title={it.detail}>
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-bold text-[10px]">{it.code}</span>
                      <span className="font-mono text-[10px] text-[#5A5870]">
                        {g.sign}
                        {it.points}
                      </span>
                    </div>
                    <p className="text-[#5A5870] leading-snug">{it.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {rc.why_chosen.length > 0 && (
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#5A5870] mb-1">Why this choice</p>
          <ul className="list-disc pl-5 space-y-0.5 text-xs text-[#17151F]">
            {rc.why_chosen.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {rc.alternatives.length > 0 && (
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#5A5870] mb-1">
            Alternatives on the same scale
          </p>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs bg-[#B9E4A1]/50 border border-[#17151F]/30 rounded-full pl-1 pr-2 py-0.5">
              <CodeChip>{rc.after.package || "chosen"}</CodeChip>
              <span className="font-mono font-bold">{rc.after.score}</span>
              <span className="text-[#5A5870]">chosen</span>
            </span>
            {rc.alternatives.map((a) => (
              <span
                key={a.package}
                className="inline-flex items-center gap-1.5 text-xs bg-[#F5F1E8] border border-[#17151F]/20 rounded-full pl-1 pr-2 py-0.5"
              >
                <CodeChip>{a.package}</CodeChip>
                <span className="font-mono font-bold">{a.score ?? "?"}</span>
                {a.level && <span className="text-[#5A5870]">{a.level}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="text-[10px] text-[#5A5870]">
        Computed from registry and OSV data; scores use the same point values as the risk scan.
      </p>
    </div>
  );
}
