"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { parseAccountsCsv, readCsvText } from "@/lib/csv";
import {
  checkExclusion,
  cleanCompanyName,
  normalizeCompanyName,
} from "@/lib/prefilter";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

export async function createRun(formData: FormData) {
  const { user, supabase } = await verifySession();

  const name = String(formData.get("name") ?? "").trim();
  const file = formData.get("file");
  if (!name) throw new Error("Run name is required");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Upload a CSV file");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("File too large (limit 5 MB for v1)");
  }

  const text = await readCsvText(file);
  const parsed = parseAccountsCsv(text);
  if (parsed.rows.length === 0) {
    throw new Error("CSV has no data rows");
  }

  // 1. Create the run row in "running" state.
  const { data: run, error: runErr } = await supabase
    .from("runs")
    .insert({
      user_id: user.id,
      name,
      csv_filename: file.name,
      total_accounts: parsed.rows.length,
      status: "running",
    })
    .select("id")
    .single();
  if (runErr || !run) {
    throw new Error(`Failed to create run: ${runErr?.message ?? "unknown"}`);
  }

  // 2. Build a per-CSV-row record. Collapse duplicate normalized names within the
  //    CSV so we don't double-insert companies; keep the first display name.
  type Row = {
    display: string;
    clean: string;
    normalized: string;
    website: string | null;
    excluded: boolean;
    industry: string | null;
    excludeReason: string | null;
  };
  const seenNormalized = new Set<string>();
  const csvRows: Row[] = [];
  for (const r of parsed.rows) {
    const normalized = normalizeCompanyName(r.name);
    if (!normalized || seenNormalized.has(normalized)) continue;
    seenNormalized.add(normalized);
    const clean = cleanCompanyName(r.name);
    const result = checkExclusion(r.name);
    csvRows.push({
      display: r.name,
      clean,
      normalized,
      website: r.website,
      excluded: result.excluded,
      industry: result.excluded ? result.category : null,
      excludeReason: result.excluded ? result.reason : null,
    });
  }

  // 3. Look up existing companies by normalized name (shared cache).
  const normalizedKeys = csvRows.map((r) => r.normalized);
  const { data: existing, error: lookupErr } = await supabase
    .from("companies")
    .select("id, name_normalized, exclude_flag, exclude_reason, industry_guess, fit_tier")
    .in("name_normalized", normalizedKeys);
  if (lookupErr) {
    await supabase
      .from("runs")
      .update({ status: "failed" })
      .eq("id", run.id);
    throw new Error(`Company lookup failed: ${lookupErr.message}`);
  }
  const existingByKey = new Map(
    (existing ?? []).map((c) => [c.name_normalized, c]),
  );

  // 4. Insert any rows that don't have a cached company yet.
  const toInsert = csvRows
    .filter((r) => !existingByKey.has(r.normalized))
    .map((r) => ({
      name_normalized: r.normalized,
      display_name: r.display,
      clean_name: r.clean,
      website: r.website,
      industry_guess: r.industry,
      exclude_flag: r.excluded,
      exclude_reason: r.excludeReason,
      fit_tier: r.excluded ? "excluded" : null,
      fit_score: r.excluded ? 0 : null,
    }));

  if (toInsert.length > 0) {
    const { data: inserted, error: insertErr } = await supabase
      .from("companies")
      .insert(toInsert)
      .select(
        "id, name_normalized, exclude_flag, exclude_reason, industry_guess, fit_tier",
      );
    if (insertErr) {
      await supabase
        .from("runs")
        .update({ status: "failed" })
        .eq("id", run.id);
      throw new Error(`Company insert failed: ${insertErr.message}`);
    }
    for (const c of inserted ?? []) {
      existingByKey.set(c.name_normalized, c);
    }
  }

  // 5. Build run_accounts. Alphabet group from first letter of clean name; rank
  //    is the global index over the sorted-by-clean-name run for now.
  const sorted = [...csvRows].sort((a, b) =>
    a.clean.localeCompare(b.clean, undefined, { sensitivity: "base" }),
  );

  const runAccountRows = sorted.map((r, idx) => {
    const company = existingByKey.get(r.normalized)!;
    const isExcluded = r.excluded || company.exclude_flag;
    const firstChar = (r.clean[0] ?? "#").toUpperCase();
    return {
      run_id: run.id,
      company_id: company.id,
      alphabet_group: /[A-Z]/.test(firstChar) ? firstChar : "#",
      territory_rank: idx + 1,
      score_snapshot: isExcluded ? 0 : null,
      tier_snapshot: isExcluded ? "excluded" : null,
      needs_human_review: false,
    };
  });

  // Insert in chunks of 200.
  for (let i = 0; i < runAccountRows.length; i += 200) {
    const chunk = runAccountRows.slice(i, i + 200);
    const { error: raErr } = await supabase.from("run_accounts").insert(chunk);
    if (raErr) {
      await supabase
        .from("runs")
        .update({ status: "failed" })
        .eq("id", run.id);
      throw new Error(`Run account insert failed: ${raErr.message}`);
    }
  }

  const excludedCount = runAccountRows.filter((r) => r.tier_snapshot === "excluded").length;
  const readyCount = runAccountRows.length - excludedCount;

  await supabase
    .from("runs")
    .update({
      total_accounts: runAccountRows.length,
      excluded_count: excludedCount,
      ready_count: readyCount,
      status: "complete",
    })
    .eq("id", run.id);

  revalidatePath("/runs");
  // ?auto=1 tells the run detail page to kick off Stage 2 → 3 → 4 immediately
  // without further clicks. Per-stage controls remain available for retries.
  redirect(`/runs/${run.id}?auto=1`);
}
