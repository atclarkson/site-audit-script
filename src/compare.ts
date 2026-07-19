import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "csv-stringify/sync";

export type RedirectRules = {
  exact: Map<string, string>;
  regex: Array<{ pattern: RegExp; replacement: string }>;
};

export type GscRow = {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

type AggregateRow = {
  url: string;
  beforeClicks: number;
  afterClicks: number;
  beforeImpressions: number;
  afterImpressions: number;
  beforeCtrNumerator: number;
  afterCtrNumerator: number;
  beforePositionNumerator: number;
  afterPositionNumerator: number;
  beforePositionWeight: number;
  afterPositionWeight: number;
  variantUrls: Set<string>;
  beforeSourceUrls: Set<string>;
  afterSourceUrls: Set<string>;
};

export type ComparisonRow = {
  priority: number;
  url: string;
  before_clicks: number;
  after_clicks: number;
  click_change: number;
  click_change_percent: string;
  before_impressions: number;
  after_impressions: number;
  impression_change: number;
  impression_change_percent: string;
  before_ctr: string;
  after_ctr: string;
  before_position: string;
  after_position: string;
  position_change: string;
  old_urls: string;
  migration_status: string;
  recommended_action: string;
};

const DEFAULT_BEFORE_PATH = "input/gsc-before.csv";
const DEFAULT_AFTER_PATH = "input/gsc-after.csv";
const DEFAULT_REDIRECTS_PATH = "input/redirects.yaml";
const DEFAULT_OUTPUT_PATH = "output/gsc-comparison.csv";

export function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values.map((value) => value.trim());
}

export function parseNumber(value: string): number {
  const cleaned = value.replace(/[%,$\s]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizePath(pathname: string): string {
  const withoutQuery = pathname.split("?")[0].split("#")[0] ?? pathname;
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  if (withLeadingSlash === "/") {
    return "/";
  }
  return `${withLeadingSlash.replace(/\/+$/, "")}/`;
}

export function normalizeSiteUrl(input: string): string {
  const url = new URL(input);
  url.protocol = "https:";
  url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  url.hash = "";
  url.pathname = normalizePath(url.pathname);
  return url.toString();
}

export function parseRedirectsYaml(content: string): RedirectRules {
  const exact = new Map<string, string>();
  const regex: Array<{ pattern: RegExp; replacement: string }> = [];

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s{2}(.+?):\s+(.+)\s*$/);
    if (!match) {
      continue;
    }
    const rawFrom = match[1].trim();
    const rawTo = match[2].trim();
    if (rawFrom.startsWith("^")) {
      regex.push({ pattern: new RegExp(rawFrom), replacement: normalizePath(rawTo) });
    } else {
      exact.set(normalizePath(rawFrom), normalizePath(rawTo));
    }
  }

  return { exact, regex };
}

export function applyRedirects(url: string, rules: RedirectRules): string {
  const normalizedUrl = normalizeSiteUrl(url);
  const parsed = new URL(normalizedUrl);
  const seen = new Set<string>();

  while (true) {
    const currentPath = normalizePath(parsed.pathname);
    if (seen.has(currentPath)) {
      parsed.pathname = currentPath;
      return parsed.toString();
    }
    seen.add(currentPath);

    const exactTarget = rules.exact.get(currentPath);
    if (exactTarget) {
      parsed.pathname = exactTarget;
      continue;
    }

    const regexRule = rules.regex.find((rule) => rule.pattern.test(currentPath));
    if (regexRule) {
      parsed.pathname = normalizePath(currentPath.replace(regexRule.pattern, regexRule.replacement));
      continue;
    }

    parsed.pathname = currentPath;
    return parsed.toString();
  }
}

export function parseGscCsv(content: string): GscRow[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const urlIndex = headers.findIndex((header) => /^top pages$/i.test(header));
  const clicksIndex = headers.findIndex((header) => /^clicks$/i.test(header));
  const impressionsIndex = headers.findIndex((header) => /^impressions$/i.test(header));
  const ctrIndex = headers.findIndex((header) => /^ctr$/i.test(header));
  const positionIndex = headers.findIndex((header) => /^position$/i.test(header));

  if ([urlIndex, clicksIndex, impressionsIndex, ctrIndex, positionIndex].some((index) => index < 0)) {
    throw new Error("Could not find expected Search Console headers");
  }

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return {
      url: values[urlIndex],
      clicks: parseNumber(values[clicksIndex]),
      impressions: parseNumber(values[impressionsIndex]),
      ctr: parseNumber(values[ctrIndex]),
      position: parseNumber(values[positionIndex])
    };
  });
}

function formatPercent(change: number, baseline: number): string {
  if (baseline <= 0) {
    return "";
  }
  return `${((change / baseline) * 100).toFixed(2)}%`;
}

function formatCtr(clicks: number, impressions: number): string {
  if (impressions <= 0) {
    return "";
  }
  return `${((clicks / impressions) * 100).toFixed(2)}%`;
}

function formatPosition(numerator: number, weight: number): string {
  if (weight <= 0) {
    return "";
  }
  return (numerator / weight).toFixed(2);
}

function formatPositionChange(before: string, after: string): string {
  if (!before || !after) {
    return "";
  }
  return (Number(after) - Number(before)).toFixed(2);
}

function getMigrationStatus(row: AggregateRow): string {
  const beforeClicks = row.beforeClicks;
  const afterClicks = row.afterClicks;
  const clickDelta = afterClicks - beforeClicks;
  const migrated = [...row.beforeSourceUrls, ...row.afterSourceUrls].some((url) => url !== row.url);

  if (beforeClicks === 0 && afterClicks > 0) {
    return "NEW_URL";
  }
  if (beforeClicks + afterClicks <= 1 && row.beforeImpressions + row.afterImpressions < 50) {
    return "NO_RECENT_TRAFFIC";
  }
  if (clickDelta <= -Math.max(5, beforeClicks * 0.2)) {
    return migrated ? "MIGRATED_AND_DECLINED" : "UNCHANGED_URL_DECLINED";
  }
  if (clickDelta >= Math.max(5, Math.max(1, beforeClicks * 0.2))) {
    return migrated ? "MIGRATED_AND_IMPROVED" : "UNCHANGED_URL_IMPROVED";
  }
  return migrated ? "MIGRATED_AND_STABLE" : "UNCHANGED_URL_STABLE";
}

function getRecommendedAction(status: string, row: AggregateRow): string {
  if (status === "MIGRATED_AND_DECLINED") {
    if (row.afterClicks === 0) {
      return "Check that the migration target is correct and still matches the old search intent. Review redirects, canonicals, and internal links.";
    }
    return "Review whether the migrated page still matches the old ranking intent. Check redirects, canonicals, internal links, and on-page alignment.";
  }
  if (status === "UNCHANGED_URL_DECLINED") {
    return "Review whether rankings or snippets changed for this URL after migration. Check indexing, title alignment, and internal links.";
  }
  if (status === "MIGRATED_AND_IMPROVED" || status === "UNCHANGED_URL_IMPROVED") {
    return "No urgent action. Keep monitoring the gain.";
  }
  if (status === "NEW_URL") {
    return "Monitor this new page. There is no pre-migration traffic baseline to recover.";
  }
  if (status === "NO_RECENT_TRAFFIC") {
    return "No urgent action. Traffic is too low to judge migration impact reliably.";
  }
  return "No urgent action. Keep monitoring this page.";
}

export function buildComparisonRows(beforeRows: GscRow[], afterRows: GscRow[], rules: RedirectRules): ComparisonRow[] {
  const aggregates = new Map<string, AggregateRow>();

  const ingest = (rows: GscRow[], phase: "before" | "after"): void => {
    for (const row of rows) {
      const sourceUrl = normalizeSiteUrl(row.url);
      const finalUrl = applyRedirects(sourceUrl, rules);
      const aggregate = aggregates.get(finalUrl) ?? {
        url: finalUrl,
        beforeClicks: 0,
        afterClicks: 0,
        beforeImpressions: 0,
        afterImpressions: 0,
        beforeCtrNumerator: 0,
        afterCtrNumerator: 0,
        beforePositionNumerator: 0,
        afterPositionNumerator: 0,
        beforePositionWeight: 0,
        afterPositionWeight: 0,
        variantUrls: new Set<string>(),
        beforeSourceUrls: new Set<string>(),
        afterSourceUrls: new Set<string>()
      };

      aggregate.variantUrls.add(sourceUrl);
      if (phase === "before") {
        aggregate.beforeClicks += row.clicks;
        aggregate.beforeImpressions += row.impressions;
        aggregate.beforeCtrNumerator += row.clicks;
        aggregate.beforePositionNumerator += row.position * row.impressions;
        aggregate.beforePositionWeight += row.impressions;
        aggregate.beforeSourceUrls.add(sourceUrl);
      } else {
        aggregate.afterClicks += row.clicks;
        aggregate.afterImpressions += row.impressions;
        aggregate.afterCtrNumerator += row.clicks;
        aggregate.afterPositionNumerator += row.position * row.impressions;
        aggregate.afterPositionWeight += row.impressions;
        aggregate.afterSourceUrls.add(sourceUrl);
      }

      aggregates.set(finalUrl, aggregate);
    }
  };

  ingest(beforeRows, "before");
  ingest(afterRows, "after");

  return [...aggregates.values()].map((row) => {
    const clickChange = row.afterClicks - row.beforeClicks;
    const impressionChange = row.afterImpressions - row.beforeImpressions;
    const beforePosition = formatPosition(row.beforePositionNumerator, row.beforePositionWeight);
    const afterPosition = formatPosition(row.afterPositionNumerator, row.afterPositionWeight);
    const migrationStatus = getMigrationStatus(row);
    const oldUrls = [...row.variantUrls].filter((url) => url !== row.url).sort().join("; ");

    return {
      priority: Math.max(0, row.beforeClicks - row.afterClicks),
      url: row.url,
      before_clicks: row.beforeClicks,
      after_clicks: row.afterClicks,
      click_change: clickChange,
      click_change_percent: formatPercent(clickChange, row.beforeClicks),
      before_impressions: row.beforeImpressions,
      after_impressions: row.afterImpressions,
      impression_change: impressionChange,
      impression_change_percent: formatPercent(impressionChange, row.beforeImpressions),
      before_ctr: formatCtr(row.beforeCtrNumerator, row.beforeImpressions),
      after_ctr: formatCtr(row.afterCtrNumerator, row.afterImpressions),
      before_position: beforePosition,
      after_position: afterPosition,
      position_change: formatPositionChange(beforePosition, afterPosition),
      old_urls: oldUrls,
      migration_status: migrationStatus,
      recommended_action: getRecommendedAction(migrationStatus, row)
    };
  }).sort((a, b) =>
    b.priority - a.priority ||
    (b.before_impressions - b.after_impressions) - (a.before_impressions - a.after_impressions) ||
    a.url.localeCompare(b.url)
  );
}

async function writeComparisonCsv(rows: ComparisonRow[], outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const csv = stringify(rows, {
    header: true,
    columns: [
      "priority",
      "url",
      "before_clicks",
      "after_clicks",
      "click_change",
      "click_change_percent",
      "before_impressions",
      "after_impressions",
      "impression_change",
      "impression_change_percent",
      "before_ctr",
      "after_ctr",
      "before_position",
      "after_position",
      "position_change",
      "old_urls",
      "migration_status",
      "recommended_action"
    ]
  });
  await writeFile(outputPath, csv, "utf8");
}

function printSummary(beforeRows: GscRow[], afterRows: GscRow[], rules: RedirectRules, rows: ComparisonRow[]): void {
  const totalClicksBefore = beforeRows.reduce((sum, row) => sum + row.clicks, 0);
  const totalClicksAfter = afterRows.reduce((sum, row) => sum + row.clicks, 0);
  const redirectRulesLoaded = rules.exact.size + rules.regex.length;

  console.log(`Before rows loaded: ${beforeRows.length}`);
  console.log(`After rows loaded: ${afterRows.length}`);
  console.log(`Redirect rules loaded: ${redirectRulesLoaded}`);
  console.log(`Total clicks before: ${totalClicksBefore}`);
  console.log(`Total clicks after: ${totalClicksAfter}`);
  console.log(`Net click change: ${totalClicksAfter - totalClicksBefore}`);
  console.log("Top 25 pages by clicks lost:");
  for (const row of rows.filter((candidate) => candidate.priority > 0).slice(0, 25)) {
    console.log(`- [${row.priority}] ${row.url}`);
  }
}

async function main(): Promise<void> {
  const [beforeContent, afterContent, redirectsContent] = await Promise.all([
    readFile(DEFAULT_BEFORE_PATH, "utf8"),
    readFile(DEFAULT_AFTER_PATH, "utf8"),
    readFile(DEFAULT_REDIRECTS_PATH, "utf8")
  ]);

  const beforeRows = parseGscCsv(beforeContent);
  const afterRows = parseGscCsv(afterContent);
  const rules = parseRedirectsYaml(redirectsContent);
  const rows = buildComparisonRows(beforeRows, afterRows, rules);

  await writeComparisonCsv(rows, DEFAULT_OUTPUT_PATH);
  printSummary(beforeRows, afterRows, rules, rows);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
