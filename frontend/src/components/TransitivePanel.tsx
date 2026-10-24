"use client";

import React, { useState } from "react";
import type { Transitive, TransitiveItem } from "@/lib/types";
import { ChevronRight, ExternalLink, GitFork, Info } from "lucide-react";

const SEV_CHIP: Record<string, string> = {
  critical: "bg-[#FDECEC] text-[#D64545] border-[#D64545]",
  high: "bg-[#F2A58B] text-[#17151F] border-[#17151F]/40",
  moderate: "bg-[#F9D56E] text-[#17151F] border-[#17151F]/40",
  medium: "bg-[#F9D56E] text-[#17151F] border-[#17151F]/40",
  low: "bg-[#A8CCF4] text-[#17151F] border-[#17151F]/40",
  unknown: "bg-[#F5F1E8] text-[#5A5870] border-[#17151F]/20",
};

function worst(item: TransitiveItem): string {
  const order = ["critical", "high", "moderate", "medium", "low", "unknown"];
  return item.vulnerabilities.map((v) => v.severity).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "unknown";
}

/** "your app → express 4.17.1 → qs 6.7.0": the last link is the vulnerable package. */
export function DependencyPath({ path }: { path: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
      {path.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight className="w-3 h-3 text-[#5A5870]" />}
          <span
            className={`px-1.5 py-0.5 rounded border ${
              i === 0
                ? "bg-[#17151F] text-white border-[#17151F]"
                : i === path.length - 1
                  ? "bg-[#FDECEC] text-[#D64545] border-[#D64545] font-bold"
                  : "bg-white text-[#17151F] border-[#17151F]/30"
            }`}
          >
            {p}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

export function TransitiveItemCard({ item }: { item: TransitiveItem }) {
  const [open, setOpen] = useState(false);
  const sev = worst(item);
  return (
    <div className="border-2 border-[#17151F]/15 rounded-2xl p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-bold text-[#17151F]">
          {item.name} {item.version}
        </span>
        <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full border ${SEV_CHIP[sev] ?? SEV_CHIP.unknown}`}>
          {sev}
        </span>
        <span className="text-[11px] text-[#5A5870]">
          {item.vulnerabilities.length} advisor{item.vulnerabilities.length === 1 ? "y" : "ies"}
        </span>
        {item.dev && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#F5F1E8] border border-[#17151F]/20">dev only</span>
        )}
      </div>
      <div className="space-y-1">
        {item.paths.map((p, i) => (
          <DependencyPath key={i} path={p} />
        ))}
      </div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-bold text-[#6E56D9] cursor-pointer">
        {open ? "Hide" : "Show"} advisories
      </button>
      {open && (
        <ul className="space-y-1.5">
          {item.vulnerabilities.map((v) => (
            <li key={v.id} className="text-xs flex flex-wrap items-start gap-x-2 gap-y-0.5">
              <a href={v.url} target="_blank" rel="noreferrer" className="font-mono font-bold underline inline-flex items-center gap-0.5">
                {v.id} <ExternalLink className="w-3 h-3" />
              </a>
              <span className={`text-[9px] font-extrabold uppercase px-1.5 rounded-full border ${SEV_CHIP[v.severity] ?? SEV_CHIP.unknown}`}>
                {v.severity}
              </span>
              <span className="text-[#17151F] basis-full sm:basis-auto sm:flex-1">{v.summary}</span>
              {v.fixed_in.length > 0 && (
                <span className="font-mono text-[11px] text-[#3D7A25]">fixed in {v.fixed_in.join(", ")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Packages your dependencies pull in, checked against OSV, with the path that brings each one into the project. */
export function TransitivePanel({ transitive }: { transitive: Transitive }) {
  const [showDev, setShowDev] = useState(false);
  const items = transitive.items.filter((i) => showDev || !i.dev);
  const devCount = transitive.items.filter((i) => i.dev).length;
  return (
    <div className="bg-white border-[3px] border-[#17151F] rounded-[28px] shadow-[6px_6px_0_0_#17151F] p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-3 border-b border-[#17151F]/15">
        <div>
          <h3 className="font-display font-extrabold text-2xl text-[#17151F] flex items-center gap-2">
            <GitFork className="w-5 h-5" /> Pulled-in packages
          </h3>
          <p className="text-sm text-[#5A5870]">
            Transitive dependencies: installed because one of your dependencies needs them, even if your code never imports
            them. Every one is checked against OSV.
          </p>
        </div>
        {transitive.available && (
          <div className="flex flex-wrap gap-1.5 shrink-0">
            <span className="text-[11px] font-bold bg-[#F5F1E8] px-2 py-0.5 rounded-full border border-[#17151F]/20">
              {transitive.total} checked
            </span>
            <span
              className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                transitive.vulnerable ? "bg-[#FDECEC] text-[#D64545] border-[#D64545]" : "bg-[#B9E4A1] border-[#17151F]/30"
              }`}
            >
              {transitive.vulnerable} with advisories
            </span>
          </div>
        )}
      </div>

      {!transitive.available ? (
        <p className="text-sm text-[#5A5870]">Not checked: {transitive.notes.join("; ")}</p>
      ) : transitive.items.length === 0 ? (
        <p className="text-sm text-[#17151F]">
          None of the {transitive.total} pulled-in packages has a known advisory.
        </p>
      ) : (
        <>
          {devCount > 0 && (
            <label className="text-xs font-semibold text-[#17151F] flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={showDev} onChange={(e) => setShowDev(e.target.checked)} /> Show {devCount} dev-only
              package{devCount === 1 ? "" : "s"} (test and build tools, not shipped)
            </label>
          )}
          <div className="space-y-2">
            {items.map((i) => (
              <TransitiveItemCard key={`${i.name}@${i.version}`} item={i} />
            ))}
            {items.length === 0 && <p className="text-sm text-[#5A5870]">Only dev-only packages have advisories.</p>}
          </div>
        </>
      )}

      {transitive.available && (transitive.approximate || (transitive.unchecked?.length ?? 0) > 0) && (
        <p className="text-[11px] text-[#5A5870] flex gap-1.5">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            {transitive.notes.join(" ")}
            {transitive.unchecked && transitive.unchecked.length > 0 ? ` Not checked: ${transitive.unchecked.join(", ")}.` : ""}
          </span>
        </p>
      )}
    </div>
  );
}
