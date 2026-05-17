import Papa from "papaparse";

// Read a File as text. Most CSVs are UTF-8, but Excel/Numbers on Windows often
// exports Windows-1252 (cp1252), which makes curly quotes and en-dashes appear
// as "?" or "�" when force-decoded as UTF-8. Try strict UTF-8 first, fall
// back to Windows-1252 on decode failure.
export async function readCsvText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

const NAME_COLUMN_CANDIDATES = [
  "company name",
  "company",
  "account name",
  "account",
  "organization",
  "name",
  "business name",
];

const WEBSITE_COLUMN_CANDIDATES = [
  "website",
  "url",
  "domain",
  "web address",
  "company website",
  "company url",
];

export type ParsedCsv = {
  nameColumn: string;
  websiteColumn: string | null;
  rows: Array<{
    name: string;
    website: string | null;
    raw: Record<string, string>;
  }>;
};

export function parseAccountsCsv(text: string): ParsedCsv {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length) {
    const first = parsed.errors[0];
    throw new Error(
      `CSV parse error at row ${first.row ?? "?"}: ${first.message}`,
    );
  }
  const headers = parsed.meta.fields ?? [];
  const nameColumn = pickColumn(headers, NAME_COLUMN_CANDIDATES);
  if (!nameColumn) {
    throw new Error(
      `Could not find a company name column. Headers found: ${headers.join(", ")}`,
    );
  }
  const websiteColumn = pickColumn(headers, WEBSITE_COLUMN_CANDIDATES);
  const rows = parsed.data
    .map((row) => ({
      name: (row[nameColumn] ?? "").trim(),
      website: websiteColumn
        ? normalizeWebsite(row[websiteColumn] ?? "")
        : null,
      raw: row,
    }))
    .filter((r) => r.name.length > 0);
  return { nameColumn, websiteColumn, rows };
}

function pickColumn(headers: string[], candidates: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const cand of candidates) {
    const i = lower.indexOf(cand);
    if (i !== -1) return headers[i];
  }
  for (const cand of candidates) {
    const i = lower.findIndex((h) => h.includes(cand));
    if (i !== -1) return headers[i];
  }
  return null;
}

// Strip http(s)://, trailing slash, leading www. — leaves a clean domain
// that ZoomInfo's /search/company accepts as `companyWebsite`.
function normalizeWebsite(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const stripped = t
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .replace(/^www\./i, "")
    .toLowerCase()
    .trim();
  return stripped || null;
}
