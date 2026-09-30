"use client";

import { useMemo, useState } from "react";
import type { Lead } from "@/types/lead";

type SortKey = "rating" | "installs" | "relevance" | "title";

interface LeadTableProps {
  leads: Lead[];
}

function formatInstalls(lead: Lead): string {
  if (lead.installsRaw) return lead.installsRaw;
  if (lead.installs === null) return "—";
  return lead.installs.toLocaleString("en-US");
}

const PAGE_SIZE = 100;

export function LeadTable({ leads }: LeadTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "rating",
    direction: "asc",
  });
  const [visible, setVisible] = useState(PAGE_SIZE);

  const rows = useMemo(() => {
    const copy = [...leads];
    copy.sort((a, b) => {
      let delta = 0;
      switch (sort.key) {
        case "rating":
          delta = (a.rating ?? Number.POSITIVE_INFINITY) - (b.rating ?? Number.POSITIVE_INFINITY);
          break;
        case "installs":
          delta =
            (a.installs ?? a.installsUpper ?? Number.POSITIVE_INFINITY) -
            (b.installs ?? b.installsUpper ?? Number.POSITIVE_INFINITY);
          break;
        case "relevance":
          delta = a.relevanceScore - b.relevanceScore;
          break;
        case "title":
          delta = a.title.localeCompare(b.title);
          break;
      }
      if (delta === 0) return a.title.localeCompare(b.title);
      return sort.direction === "asc" ? delta : -delta;
    });
    return copy;
  }, [leads, sort]);

  const toggle = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "relevance" || key === "title" ? "desc" : "asc" },
    );

  const header = (key: SortKey, label: string) => (
    <th className="px-3 py-2 text-left font-medium">
      <button
        type="button"
        onClick={() => toggle(key)}
        className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-zinc-400 transition hover:text-zinc-200"
      >
        {label}
        <span className={sort.key === key ? "text-emerald-400" : "text-zinc-700"}>
          {sort.key === key && sort.direction === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );

  const shown = rows.slice(0, visible);

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-800 px-6 py-12 text-center">
        <p className="text-sm font-medium text-zinc-300">No leads yet</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
          Enter a keyword and your qualification rules above. Leads appear here the moment the
          server finds them, and the table keeps updating while the search runs.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-900/60">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead className="border-b border-zinc-800 bg-zinc-900">
          <tr>
            {header("title", "App")}
            {header("rating", "Rating")}
            {header("installs", "Installs")}
            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-400">
              Category
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-400">
              Developer
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-400">
              Ratings
            </th>
            {header("relevance", "Relevance")}
          </tr>
        </thead>
        <tbody>
          {shown.map((lead) => (
            <tr
              key={lead.packageName}
              className="border-b border-zinc-800/70 last:border-0 hover:bg-zinc-800/40"
            >
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  {lead.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={lead.icon}
                      alt=""
                      className="h-8 w-8 rounded-lg bg-zinc-800"
                      loading="lazy"
                    />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-800 text-xs text-zinc-500">
                      ?
                    </span>
                  )}
                  <div className="min-w-0">
                    <a
                      href={lead.playStoreUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block max-w-[18rem] truncate font-medium text-zinc-100 hover:text-emerald-400"
                      title={lead.title}
                    >
                      {lead.title}
                    </a>
                    <span className="block truncate font-mono text-[11px] text-zinc-500">
                      {lead.packageName}
                    </span>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2.5">
                <span
                  className={`rounded-md px-1.5 py-0.5 font-mono text-xs ${
                    lead.rating !== null && lead.rating <= 2
                      ? "bg-rose-500/15 text-rose-300"
                      : "bg-zinc-800 text-zinc-200"
                  }`}
                >
                  {lead.rating === null ? "—" : lead.rating.toFixed(1)}
                </span>
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-zinc-300">{formatInstalls(lead)}</td>
              <td className="px-3 py-2.5 text-xs text-zinc-400">{lead.category ?? "—"}</td>
              <td className="max-w-[10rem] truncate px-3 py-2.5 text-xs text-zinc-400">
                {lead.developer ?? "—"}
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-zinc-400">
                {lead.ratingsCount === null ? "—" : lead.ratingsCount.toLocaleString("en-US")}
              </td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${lead.relevanceScore}%` }}
                    />
                  </div>
                  <span className="font-mono text-xs text-zinc-400">{lead.relevanceScore}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <div className="flex flex-col items-center gap-1.5 border-t border-zinc-800 px-3 py-3 text-center">
          <button
            type="button"
            onClick={() => setVisible((current) => current + 200)}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-medium text-zinc-200 transition hover:border-emerald-500 hover:text-emerald-400"
          >
            Show {Math.min(200, rows.length - shown.length)} more
          </button>
          <p className="text-[11px] text-zinc-500">
            Showing {shown.length} of {rows.length} leads — CSV export always includes every lead.
          </p>
        </div>
      )}
    </div>
  );
}
