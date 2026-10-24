"use client";

import React, { useState } from "react";
import type { Dependency, Priority, PriorityLabel, PrioritySummary } from "@/lib/types";
import { ChevronRight, Zap, Clock } from "lucide-react";

export const PRIORITY_STYLE: Record<PriorityLabel, { text: string; chip: string; zone: string; dot: string }> = {
  fix_first: {
    text: "Fix first",
    chip: "bg-[#FDECEC] text-[#D64545] border-2 border-[#D64545]",
    zone: "bg-[#FDECEC]",
    dot: "#D64545",
  },
  plan: { text: "Plan", chip: "bg-[#F9D56E] text-[#17151F] border border-[#17151F]/40", zone: "bg-[#FDF1D0]", dot: "#E0A800" },
  monitor: { text: "Monitor", chip: "bg-[#A8CCF4] text-[#17151F] border border-[#17151F]/40", zone: "bg-[#EAF2FC]", dot: "#4A84C4" },
  ok: { text: "OK", chip: "bg-[#B9E4A1] text-[#17151F] border border-[#17151F]/40", zone: "bg-[#EAF6E2]", dot: "#5FA83A" },
};

export function PriorityChip({ p, small }: { p?: Priority | null; small?: boolean }) {
  if (!p) return <span className="text-xs text-[#5A5870]">—</span>;
  const s = PRIORITY_STYLE[p.label];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={p.recommendation}>
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full ${small ? "text-[10px]" : "text-[11px]"} font-extrabold uppercase tracking-wider ${s.chip}`}>
        {s.text}
      </span>
      {p.quick_win && <Zap className="w-3.5 h-3.5 text-[#E0A800]" aria-label="quick win" />}
      {p.deferred && <Clock className="w-3.5 h-3.5 text-[#5A5870]" aria-label="deferred" />}
    </span>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-[#5A5870] w-20 shrink-0">{label}</span>
      <div className="h-2 flex-1 bg-[#17151F]/5 rounded-full overflow-hidden border border-[#17151F]/15">
        <div className="h-full bg-[#17151F] rounded-full" style={{ width: `${value}%` }} />
      </div>
      <span className="font-mono text-xs font-bold w-7 text-right">{value}</span>
    </div>
  );
}

/** Severity x impact grid (2x2) with every dependency placed on it, plus the ordered work list. */
export function PriorityMatrix({
  summary,
  dependencies,
  onSelectDependency,
}: {
  summary: PrioritySummary;
  dependencies: Dependency[];
  onSelectDependency?: (dep: Dependency) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const { severity_high: SH, impact_high: IH } = summary.thresholds;
  const byName = new Map(dependencies.map((d) => [d.name, d]));
  const placed = dependencies.filter((d) => d.priority);

  // spread dependencies that land on the same spot so every dot stays clickable
  const seen = new Map<string, number>();
  const dots = placed.map((d) => {
    const p = d.priority!;
    const key = `${Math.round(p.impact.score / 4)}:${Math.round(p.severity / 4)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { d, p, x: Math.min(97, Math.max(3, p.impact.score)), y: Math.min(95, Math.max(4, p.severity)), n };
  });

  const order = summary.order.map((n) => byName.get(n)).filter((d): d is Dependency => !!d && !!d.priority);

  const zone = (label: PriorityLabel, title: string, sub: string, cls: string) => (
    <div className={`${PRIORITY_STYLE[label].zone} ${cls} p-2 flex flex-col`}>
      <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#17151F]">{title}</span>
      <span className="text-[10px] text-[#5A5870] leading-tight">{sub}</span>
    </div>
  );

  return (
    <div className="bg-white border-[3px] border-[#17151F] rounded-[28px] shadow-[6px_6px_0_0_#17151F] p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-3 border-b border-[#17151F]/15">
        <div>
          <h3 className="font-display font-extrabold text-2xl text-[#17151F]">What to fix first</h3>
          <p className="text-sm text-[#5A5870]">
            Severity (how bad the package is) × impact (how far it reaches into your code, from the blast radius) ×
            change cost (how big the fix is). A tiny package wired into the core ranks above a risky one used once.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 shrink-0">
          {(["fix_first", "plan", "monitor", "ok"] as PriorityLabel[]).map((l) => (
            <span key={l} className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${PRIORITY_STYLE[l].chip}`}>
              {summary.counts[l] ?? 0} {PRIORITY_STYLE[l].text}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
        {/* 2x2 grid */}
        <div>
          <div className="flex gap-2">
            <div className="flex items-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#5A5870] [writing-mode:vertical-rl] rotate-180">
                Severity →
              </span>
            </div>
            <div className="relative flex-1 aspect-square max-h-[420px] border-2 border-[#17151F] rounded-xl overflow-hidden">
              {/* quadrant backgrounds (thresholds come from the capsule) */}
              <div
                className="absolute inset-0 grid"
                style={{ gridTemplateColumns: `${IH}% ${100 - IH}%`, gridTemplateRows: `${100 - SH}% ${SH}%` }}
              >
                {zone("plan", "Plan", "risky but contained", "border-r border-b border-dashed border-[#17151F]/30")}
                {zone("fix_first", "Fix first", "risky and wide reach", "border-b border-dashed border-[#17151F]/30 items-end text-right")}
                {zone("monitor", "Monitor", "moderate on both", "border-r border-dashed border-[#17151F]/30 justify-end")}
                {zone("plan", "Plan", "wide reach, moderate risk", "justify-end items-end text-right")}
              </div>
              {dots.map(({ d, p, x, y, n }) => (
                <button
                  key={d.name}
                  type="button"
                  onClick={() => onSelectDependency?.(d)}
                  onMouseEnter={() => setHover(d.name)}
                  onMouseLeave={() => setHover(null)}
                  title={`${d.name}: severity ${p.severity}, impact ${p.impact.score}, change cost ${p.change_cost.score}`}
                  className="absolute -translate-x-1/2 translate-y-1/2 flex items-center gap-1 cursor-pointer group"
                  style={{ left: `${x}%`, bottom: `calc(${y}% + ${n * 14}px)`, zIndex: hover === d.name ? 20 : 10 }}
                >
                  <span
                    className="block w-3 h-3 rounded-full border-2 border-[#17151F] group-hover:scale-125 transition"
                    style={{ background: PRIORITY_STYLE[p.label].dot }}
                  />
                  <span
                    className={`font-mono text-[10px] font-bold px-1 rounded bg-white/90 border border-[#17151F]/20 whitespace-nowrap ${
                      p.label === "ok" && hover !== d.name ? "hidden" : ""
                    }`}
                  >
                    {d.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#5A5870] text-center mt-1 ml-6">
            Impact (reach into your code) →
          </p>
        </div>

        {/* ordered work list */}
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[#5A5870] mb-2">Work order</p>
          {order.length === 0 ? (
            <p className="text-sm text-[#5A5870] italic">Nothing needs action.</p>
          ) : (
            <ol className="divide-y divide-[#17151F]/10">
              {order.map((d, i) => {
                const p = d.priority!;
                return (
                  <li key={d.name}>
                    <button
                      type="button"
                      onClick={() => onSelectDependency?.(d)}
                      onMouseEnter={() => setHover(d.name)}
                      onMouseLeave={() => setHover(null)}
                      className={`group w-full text-left py-2.5 px-2 rounded-lg flex gap-3 items-start cursor-pointer ${
                        hover === d.name ? "bg-[#FDF1D0]/70" : "hover:bg-[#FDF1D0]/50"
                      }`}
                    >
                      <span className="font-mono text-xs font-bold text-[#5A5870] w-5 pt-0.5">{i + 1}</span>
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-bold text-[#17151F]">{d.name}</span>
                          <PriorityChip p={p} small />
                        </div>
                        <p className="text-xs text-[#5A5870] leading-snug">{p.recommendation}</p>
                        <div className="flex flex-wrap gap-x-3 text-[10px] font-mono text-[#5A5870]">
                          <span>severity {p.severity}</span>
                          <span>impact {p.impact.score}</span>
                          <span>change cost {p.change_cost.score}</span>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-[#5A5870] mt-1 group-hover:translate-x-1 transition" />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="text-[10px] text-[#5A5870] mt-2 flex flex-wrap gap-3">
            <span className="inline-flex items-center gap-1"><Zap className="w-3 h-3 text-[#E0A800]" /> quick win: small change, big risk drop</span>
            <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> deferred: large change for a small gain</span>
          </p>
        </div>
      </div>
    </div>
  );
}

/** Detail view: why this dependency got its label. */
export function PriorityDetail({ p }: { p: Priority }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PriorityChip p={p} />
        <p className="text-sm font-medium text-[#17151F]">{p.recommendation}</p>
      </div>
      <div className="space-y-1.5">
        <Meter label="Severity" value={p.severity} />
        <Meter label="Impact" value={p.impact.score} />
        <Meter label="Change cost" value={p.change_cost.score} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className="rounded-xl border border-[#17151F]/20 bg-[#F5F1E8] p-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#5A5870] mb-1">Impact: {p.impact.score}</p>
          <ul className="list-disc pl-4 space-y-0.5 text-xs text-[#17151F]">
            {p.impact.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-[#17151F]/20 bg-[#F5F1E8] p-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[#5A5870] mb-1">
            Change cost: {p.change_cost.score}
          </p>
          <ul className="list-disc pl-4 space-y-0.5 text-xs text-[#17151F]">
            {p.change_cost.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
