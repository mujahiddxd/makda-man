"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, History } from "lucide-react";
import type { AnalysesListItem } from "@/lib/types";
import { CodeChip } from "./ui/Base";

const FINISHED_OK = new Set(["completed", "completed_with_errors"]);

function statusColor(status: string) {
  return status === "completed"
    ? "bg-[#B9E4A1] text-[#17151F]"
    : status === "completed_with_errors"
      ? "bg-[#F9D56E] text-[#17151F]"
      : status === "failed"
        ? "bg-[#FDECEC] text-[#D64545] border-[#D64545]"
        : "bg-white text-[#17151F]";
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border border-[#17151F]/30 uppercase tracking-wider whitespace-nowrap ${statusColor(status)}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** One card per repository: opens its latest successful run; earlier runs (incl. failed ones) fold away. */
export function RecentAnalyses({ items }: { items: AnalysesListItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);

  const groups = new Map<string, AnalysesListItem[]>();
  for (const it of [...items].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    const key = it.repo_url.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(it);
  }
  const rows = [...groups.values()].map((runs) => {
    const main = runs.find((r) => FINISHED_OK.has(r.status)) ?? runs[0]; // latest good run, else the latest attempt
    return { main, others: runs.filter((r) => r !== main) };
  });

  if (!rows.length) {
    return (
      <div className="p-8 text-center text-sm font-semibold text-[#5A5870] bg-white rounded-2xl border-2 border-dashed border-[#17151F]/20">
        No previous analyses found.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map(({ main, others }) => {
        const expanded = open === main.id;
        const failed = others.filter((r) => r.status === "failed").length;
        const active = others.filter((r) => r.status === "running" || r.status === "queued");
        return (
          <div key={main.id} className="bg-white border-[3px] border-[#17151F] rounded-2xl shadow-[4px_4px_0_0_#17151F]">
            <div
              role="link"
              tabIndex={0}
              onClick={() => router.push(`/analyses/${main.id}`)}
              onKeyDown={(e) => e.key === "Enter" && router.push(`/analyses/${main.id}`)}
              className="p-4 cursor-pointer hover:bg-[#FDF1D0]/40 rounded-2xl transition flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-[#F5F1E8] border-2 border-[#17151F] flex items-center justify-center font-bold text-xs shrink-0">
                  📦
                </div>
                <div className="min-w-0">
                  <h4 className="font-mono text-sm font-bold text-[#17151F] flex flex-wrap items-center gap-2">
                    <span className="break-all">{main.repo_url.replace(/^https:\/\/github\.com\//, "")}</span>
                    <CodeChip>{main.id}</CodeChip>
                  </h4>
                  <p className="text-xs text-[#5A5870] font-medium mt-0.5">
                    {FINISHED_OK.has(main.status) ? "Latest result" : "Latest attempt"} ·{" "}
                    {new Date(main.created_at).toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {main.summary && (
                  <span className="text-xs font-semibold text-[#17151F] bg-[#F5F1E8] px-2.5 py-1 rounded-full border border-[#17151F]/20 whitespace-nowrap">
                    {main.summary.at_risk} of {main.summary.dependencies_total} at risk
                  </span>
                )}
                <StatusChip status={main.status} />
                {active.length > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/analyses/${active[0].id}`);
                    }}
                    title={`Open the run in progress (${active[0].id})`}
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full border border-[#6E56D9] bg-[#EEEAFB] text-[#4B3BA8] cursor-pointer whitespace-nowrap"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-[#6E56D9] animate-pulse" /> new run in progress
                  </button>
                )}
                {others.length > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(expanded ? null : main.id);
                    }}
                    aria-expanded={expanded}
                    className="inline-flex items-center gap-1 text-xs font-bold text-[#17151F] bg-white border border-[#17151F]/30 rounded-full px-2.5 py-1 hover:bg-[#F9D56E] cursor-pointer whitespace-nowrap"
                  >
                    <History className="w-3.5 h-3.5" />
                    {others.length} other run{others.length === 1 ? "" : "s"}
                    {failed > 0 && <span className="text-[#D64545]">· {failed} failed</span>}
                    <ChevronDown className={`w-3.5 h-3.5 transition ${expanded ? "rotate-180" : ""}`} />
                  </button>
                )}
                <ArrowRight className="w-4 h-4 text-[#5A5870] hidden sm:block" />
              </div>
            </div>
            {expanded && (
              <ul className="border-t-2 border-[#17151F]/10 divide-y divide-[#17151F]/10">
                {others.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => router.push(`/analyses/${r.id}`)}
                      className="w-full text-left px-4 py-2 flex flex-wrap items-center justify-between gap-2 hover:bg-[#F5F1E8] cursor-pointer"
                    >
                      <span className="flex items-center gap-2 text-xs text-[#5A5870]">
                        <CodeChip>{r.id}</CodeChip>
                        {new Date(r.created_at).toLocaleString()}
                      </span>
                      <span className="flex items-center gap-2">
                        {r.summary && (
                          <span className="text-[11px] text-[#5A5870]">
                            {r.summary.at_risk} of {r.summary.dependencies_total} at risk
                          </span>
                        )}
                        <StatusChip status={r.status} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
