import type { Lead } from "@/types/lead";

const HEADERS = [
  "App Name",
  "Package Name",
  "Developer",
  "Rating",
  "Ratings Count",
  "Installs",
  "Category",
  "Keyword Relevance",
  "Play Store URL",
];

function escapeCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function leadRow(lead: Lead): string[] {
  return [
    lead.title,
    lead.packageName,
    lead.developer ?? "",
    lead.rating === null ? "" : lead.rating.toFixed(1),
    lead.ratingsCount === null ? "" : String(lead.ratingsCount),
    lead.installsRaw ?? (lead.installs === null ? "" : String(lead.installs)),
    lead.category ?? "",
    `${lead.relevanceScore}%`,
    lead.playStoreUrl,
  ];
}

export function leadsToCsv(leads: Lead[]): string {
  const rows = [HEADERS, ...leads.map(leadRow)];
  return rows.map((row) => row.map(escapeCell).join(",")).join("\r\n");
}

export function csvFilename(keyword: string): string {
  const slug = keyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `playstore-leads-${slug || "export"}-${new Date().toISOString().slice(0, 10)}.csv`;
}
