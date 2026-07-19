import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "csv-stringify/sync";
import type { AuditRow, PageMetrics } from "./types.js";

export async function writeCsv(rows: AuditRow[], outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const csv = stringify(rows, {
    header: true,
    columns: [
      "priority",
      "url",
      "page_type",
      "status",
      "indexable",
      "title",
      "h1",
      "word_count",
      "technical_issues",
      "content_risk",
      "recommended_action",
      "response_time_ms",
      "canonical",
      "internal_links",
      "external_links",
      "images_missing_alt",
      "duplicate_type",
      "duplicate_urls",
      "similarity"
    ]
  });
  await writeFile(outputPath, csv, "utf8");
}

export function printSummary(metrics: PageMetrics[], rows: AuditRow[], outputPath: string): void {
  const lowValueTypes = new Set(["LEGAL", "UTILITY", "TAG_ARCHIVE", "AUTHOR_ARCHIVE"]);
  const brokenPages = metrics.filter((page) => Boolean(page.fetchError) || page.status >= 400).length;
  const unexpectedNoindexPages = metrics.filter((page) => !page.indexable && !lowValueTypes.has(page.pageType)).length;
  const contentPages = metrics.filter((page) => page.pageType === "CONTENT" || page.pageType === "HOMEPAGE").length;
  const archiveUtilityLegalPages = metrics.filter((page) => lowValueTypes.has(page.pageType)).length;
  const groupKey = (row: AuditRow) => [row.url, ...row.duplicate_urls.split(", ").filter(Boolean)].sort().join(" | ");
  const exactDuplicateGroups = new Set(rows.filter((row) => row.duplicate_type === "EXACT_CONTENT").map(groupKey)).size;
  const nearDuplicateGroups = new Set(rows.filter((row) => row.duplicate_type === "NEAR_DUPLICATE").map(groupKey)).size;
  const meaningfulFindings = rows.filter((row) => row.priority > 0 || row.technical_issues || row.content_risk).length;

  console.log("Finished");
  console.log(`Report: ${outputPath}`);
  console.log(`Pages crawled: ${metrics.length}`);
  console.log(`Content pages: ${contentPages}`);
  console.log(`Archive/utility/legal pages: ${archiveUtilityLegalPages}`);
  console.log(`Broken pages: ${brokenPages}`);
  console.log(`Unexpected noindex pages: ${unexpectedNoindexPages}`);
  console.log(`Exact duplicate groups: ${exactDuplicateGroups}`);
  console.log(`Near-duplicate groups: ${nearDuplicateGroups}`);
  console.log(`Pages with meaningful findings: ${meaningfulFindings}`);
  console.log("Top 20 priority URLs:");
  const topRows = rows.filter((row) =>
    !lowValueTypes.has(row.page_type) ||
    row.status === "FAILED" ||
    Number(row.status) >= 400 ||
    row.severe_canonical_issue === "yes"
  );
  for (const row of topRows.slice(0, 20)) {
    console.log(`- [${row.priority}] ${row.url}`);
  }
}
