import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { load as loadHtml } from "cheerio";
import { stringify } from "csv-stringify/sync";
import { fetchWithLimit, parseSitemapXml } from "./crawl.js";
import type { AuditOptions } from "./types.js";
import { applyRedirects, normalizePath, normalizeSiteUrl, parseCsvLine, parseGscCsv, parseRedirectsYaml, type GscRow, type RedirectRules } from "./compare.js";

type AggregateRow = {
  url: string;
  beforeClicks: number;
  afterClicks: number;
  beforeImpressions: number;
  afterImpressions: number;
  beforePositionNumerator: number;
  afterPositionNumerator: number;
  beforePositionWeight: number;
  afterPositionWeight: number;
  sourceUrls: Set<string>;
  beforeSourceUrls: Set<string>;
  afterSourceUrls: Set<string>;
};

type CrawlCsvRow = {
  url: string;
};

type LiveCheck = {
  requestedUrl: string;
  finalUrl: string;
  httpStatus: string;
  redirectChain: string;
  redirectHops: number;
  canonical: string;
  metaRobots: string;
  indexable: string;
  technicalIssue: string;
};

type RecoveryRow = {
  priority: number;
  url: string;
  before_clicks: number;
  after_clicks: number;
  click_loss: number;
  before_impressions: number;
  after_impressions: number;
  impression_loss: number;
  before_position: string;
  after_position: string;
  position_change: string;
  old_urls: string;
  final_url: string;
  http_status: string;
  redirect_chain: string;
  redirect_hops: number;
  canonical: string;
  meta_robots: string;
  indexable: string;
  in_sitemap: string;
  recovery_bucket: string;
  technical_issue: string;
  recommended_action: string;
};

const DEFAULT_BEFORE_PATH = "input/april-2day.csv";
const DEFAULT_AFTER_PATH = "input/july-2day.csv";
const DEFAULT_REDIRECTS_PATH = "input/redirects.yaml";
const DEFAULT_CRAWL_PATH = "output/site-audit.csv";
const DEFAULT_OUTPUT_PATH = "output/recovery-report.csv";

const REQUEST_OPTIONS: AuditOptions = {
  limit: 25,
  outputPath: DEFAULT_OUTPUT_PATH,
  concurrency: 5,
  timeoutMs: 15_000,
  maxBodyBytes: 5 * 1024 * 1024,
  userAgent: "AdamAndLindsSiteAudit/1.0"
};

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

function parseCrawlCsv(content: string): Set<string> {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    return new Set();
  }
  const headers = parseCsvLine(lines[0]);
  const urlIndex = headers.findIndex((header) => header === "url");
  if (urlIndex < 0) {
    return new Set();
  }
  const urls = new Set<string>();
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const url = values[urlIndex];
    if (url) {
      urls.add(normalizeSiteUrl(url));
    }
  }
  return urls;
}

function buildRecoveryAggregates(beforeRows: GscRow[], afterRows: GscRow[], rules: RedirectRules): AggregateRow[] {
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
        beforePositionNumerator: 0,
        afterPositionNumerator: 0,
        beforePositionWeight: 0,
        afterPositionWeight: 0,
        sourceUrls: new Set<string>(),
        beforeSourceUrls: new Set<string>(),
        afterSourceUrls: new Set<string>()
      };

      aggregate.sourceUrls.add(sourceUrl);
      if (phase === "before") {
        aggregate.beforeClicks += row.clicks;
        aggregate.beforeImpressions += row.impressions;
        aggregate.beforePositionNumerator += row.position * row.impressions;
        aggregate.beforePositionWeight += row.impressions;
        aggregate.beforeSourceUrls.add(sourceUrl);
      } else {
        aggregate.afterClicks += row.clicks;
        aggregate.afterImpressions += row.impressions;
        aggregate.afterPositionNumerator += row.position * row.impressions;
        aggregate.afterPositionWeight += row.impressions;
        aggregate.afterSourceUrls.add(sourceUrl);
      }

      aggregates.set(finalUrl, aggregate);
    }
  };

  ingest(beforeRows, "before");
  ingest(afterRows, "after");

  return [...aggregates.values()].sort((a, b) =>
    (b.beforeImpressions - b.afterImpressions) - (a.beforeImpressions - a.afterImpressions) ||
    (b.beforeClicks - b.afterClicks) - (a.beforeClicks - a.afterClicks) ||
    a.url.localeCompare(b.url)
  );
}

async function fetchRedirectChain(requestedUrl: string): Promise<LiveCheck> {
  const chain: string[] = [];
  const issues: string[] = [];
  let currentUrl = normalizeSiteUrl(requestedUrl);
  let finalStatus = "FAILED";
  let canonical = "";
  let metaRobots = "";
  let indexable = "no";
  let finalUrl = currentUrl;

  for (let hop = 0; hop < 10; hop += 1) {
    chain.push(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_OPTIONS.timeoutMs);
    try {
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": REQUEST_OPTIONS.userAgent,
          accept: "text/html,application/xml,text/xml;q=0.9,*/*;q=0.1"
        }
      });
      finalStatus = String(response.status);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          issues.push("Redirect missing Location header");
          finalUrl = currentUrl;
          break;
        }
        currentUrl = normalizeSiteUrl(new URL(location, currentUrl).toString());
        finalUrl = currentUrl;
        continue;
      }

      finalUrl = normalizeSiteUrl(response.url || currentUrl);
      if (response.status >= 200 && response.status < 300 && /text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "")) {
        const html = await response.text();
        const $ = loadHtml(html);
        canonical = ($("link[rel='canonical']").attr("href") ?? "").trim();
        metaRobots = ($("meta[name='robots']").attr("content") ?? "").trim();
        indexable = /noindex/i.test(metaRobots) ? "no" : "yes";
      } else {
        indexable = response.status >= 200 && response.status < 300 ? "yes" : "no";
      }

      if (response.status >= 400) {
        issues.push(`Returns HTTP ${response.status}`);
      }
      break;
    } catch (error) {
      finalStatus = "FAILED";
      issues.push(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  if (chain.length >= 10) {
    issues.push("Redirect chain exceeded 10 hops");
  }

  return {
    requestedUrl: normalizeSiteUrl(requestedUrl),
    finalUrl,
    httpStatus: finalStatus,
    redirectChain: chain.join(" -> "),
    redirectHops: Math.max(0, chain.length - 1),
    canonical,
    metaRobots,
    indexable,
    technicalIssue: issues.join("; ")
  };
}

async function loadSitemapUrls(rootUrl: string): Promise<Set<string>> {
  const queue = [new URL("/sitemap.xml", rootUrl).toString()];
  const seen = new Set<string>();
  const urls = new Set<string>();

  while (queue.length > 0 && seen.size < 20) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) {
      continue;
    }
    seen.add(sitemapUrl);
    const fetched = await fetchWithLimit(sitemapUrl, REQUEST_OPTIONS);
    if (fetched.error || fetched.status < 200 || fetched.status >= 400) {
      continue;
    }
    for (const loc of parseSitemapXml(fetched.body)) {
      const normalized = normalizeSiteUrl(loc);
      if (normalized.endsWith(".xml/") || normalized.endsWith(".xml")) {
        queue.push(normalized.replace(/\/$/, ""));
      } else {
        urls.add(normalized);
      }
    }
  }

  return urls;
}

function buildBucket(params: {
  liveCheck: LiveCheck;
  aliasChecks: LiveCheck[];
  inSitemap: boolean;
  inCrawlCsv: boolean;
  row: AggregateRow;
}): { bucket: string; technicalIssue: string; recommendedAction: string } {
  const { liveCheck, aliasChecks, inSitemap, inCrawlCsv, row } = params;
  const issues: string[] = [];

  if (liveCheck.httpStatus !== "200") {
    issues.push(`Final URL returns ${liveCheck.httpStatus}`);
  }
  if (liveCheck.indexable !== "yes") {
    issues.push("Final URL is not indexable");
  }
  if (!liveCheck.canonical) {
    issues.push("Missing canonical");
  } else {
    try {
      const resolvedCanonical = normalizeSiteUrl(new URL(liveCheck.canonical, liveCheck.finalUrl).toString());
      if (resolvedCanonical !== normalizeSiteUrl(liveCheck.finalUrl)) {
        issues.push(`Canonical points elsewhere: ${resolvedCanonical}`);
      }
    } catch {
      issues.push("Canonical is invalid");
    }
  }
  if (!inSitemap) {
    issues.push("Missing from current sitemap");
  }
  if (!inCrawlCsv) {
    issues.push("Missing from crawl CSV");
  }

  const badAlias = aliasChecks.find((aliasCheck) => normalizeSiteUrl(aliasCheck.finalUrl) !== normalizeSiteUrl(row.url));
  if (badAlias) {
    issues.push(`Alias redirects to unexpected URL: ${badAlias.requestedUrl} -> ${badAlias.finalUrl}`);
  }

  const technicalIssue = [...new Set([liveCheck.technicalIssue, ...issues].filter(Boolean).join("; ").split("; ").filter(Boolean))].join("; ");

  if (technicalIssue) {
    return {
      bucket: "TECHNICAL_MIGRATION_ISSUE",
      technicalIssue,
      recommendedAction: "Fix the redirect, indexability, canonical, or sitemap issue before judging ranking changes."
    };
  }

  const hasBlogAlias = aliasChecks.length > 0;
  if (hasBlogAlias && aliasChecks.every((aliasCheck) => normalizeSiteUrl(aliasCheck.finalUrl) === normalizeSiteUrl(row.url))) {
    if (row.beforeImpressions - row.afterImpressions <= 0 && row.beforeClicks - row.afterClicks <= 0) {
      return {
        bucket: "REDIRECT_ALIAS_OK",
        technicalIssue: "",
        recommendedAction: "No redirect fix needed. Keep monitoring performance on the consolidated URL."
      };
    }
  }

  if (liveCheck.httpStatus === "200" && liveCheck.indexable === "yes" && inSitemap) {
    return {
      bucket: "INDEXABLE_BUT_VISIBILITY_COLLAPSED",
      technicalIssue: "",
      recommendedAction: "The page looks technically valid. Inspect GSC query loss, content alignment, and ranking competitors."
    };
  }

  return {
    bucket: "NEEDS_MANUAL_GSC_INSPECTION",
    technicalIssue: "",
    recommendedAction: "Check GSC URL Inspection and query-level performance before changing the page."
  };
}

async function writeRecoveryCsv(rows: RecoveryRow[], outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const csv = stringify(rows, {
    header: true,
    columns: [
      "priority",
      "url",
      "before_clicks",
      "after_clicks",
      "click_loss",
      "before_impressions",
      "after_impressions",
      "impression_loss",
      "before_position",
      "after_position",
      "position_change",
      "old_urls",
      "final_url",
      "http_status",
      "redirect_chain",
      "redirect_hops",
      "canonical",
      "meta_robots",
      "indexable",
      "in_sitemap",
      "recovery_bucket",
      "technical_issue",
      "recommended_action"
    ]
  });
  await writeFile(outputPath, csv, "utf8");
}

export function sortRecoveryRows(rows: RecoveryRow[]): RecoveryRow[] {
  return [...rows].sort((a, b) =>
    b.impression_loss - a.impression_loss ||
    b.click_loss - a.click_loss ||
    a.url.localeCompare(b.url)
  );
}

export function classifyRecoveryRow(input: {
  url: string;
  beforeClicks: number;
  afterClicks: number;
  beforeImpressions: number;
  afterImpressions: number;
  beforePosition: string;
  afterPosition: string;
  oldUrls: string[];
  liveCheck: LiveCheck;
  aliasChecks: LiveCheck[];
  inSitemap: boolean;
  inCrawlCsv: boolean;
}): RecoveryRow {
  const row: AggregateRow = {
    url: input.url,
    beforeClicks: input.beforeClicks,
    afterClicks: input.afterClicks,
    beforeImpressions: input.beforeImpressions,
    afterImpressions: input.afterImpressions,
    beforePositionNumerator: 0,
    afterPositionNumerator: 0,
    beforePositionWeight: 0,
    afterPositionWeight: 0,
    sourceUrls: new Set(input.oldUrls),
    beforeSourceUrls: new Set(input.oldUrls),
    afterSourceUrls: new Set()
  };
  const bucket = buildBucket({
    liveCheck: input.liveCheck,
    aliasChecks: input.aliasChecks,
    inSitemap: input.inSitemap,
    inCrawlCsv: input.inCrawlCsv,
    row
  });

  return {
    priority: input.beforeImpressions - input.afterImpressions,
    url: input.url,
    before_clicks: input.beforeClicks,
    after_clicks: input.afterClicks,
    click_loss: input.beforeClicks - input.afterClicks,
    before_impressions: input.beforeImpressions,
    after_impressions: input.afterImpressions,
    impression_loss: input.beforeImpressions - input.afterImpressions,
    before_position: input.beforePosition,
    after_position: input.afterPosition,
    position_change: formatPositionChange(input.beforePosition, input.afterPosition),
    old_urls: input.oldUrls.join("; "),
    final_url: input.liveCheck.finalUrl,
    http_status: input.liveCheck.httpStatus,
    redirect_chain: input.liveCheck.redirectChain,
    redirect_hops: input.liveCheck.redirectHops,
    canonical: input.liveCheck.canonical,
    meta_robots: input.liveCheck.metaRobots,
    indexable: input.liveCheck.indexable,
    in_sitemap: input.inSitemap ? "yes" : "no",
    recovery_bucket: bucket.bucket,
    technical_issue: bucket.technicalIssue,
    recommended_action: bucket.recommendedAction
  };
}

function printSummary(beforeRows: GscRow[], afterRows: GscRow[], rows: RecoveryRow[]): void {
  const totalImpressionsBefore = beforeRows.reduce((sum, row) => sum + row.impressions, 0);
  const totalImpressionsAfter = afterRows.reduce((sum, row) => sum + row.impressions, 0);
  const totalClicksBefore = beforeRows.reduce((sum, row) => sum + row.clicks, 0);
  const totalClicksAfter = afterRows.reduce((sum, row) => sum + row.clicks, 0);
  const bucketCounts = new Map<string, number>();

  for (const row of rows) {
    bucketCounts.set(row.recovery_bucket, (bucketCounts.get(row.recovery_bucket) ?? 0) + 1);
  }

  console.log(`Before rows loaded: ${beforeRows.length}`);
  console.log(`After rows loaded: ${afterRows.length}`);
  console.log(`Total impressions before: ${totalImpressionsBefore}`);
  console.log(`Total impressions after: ${totalImpressionsAfter}`);
  console.log(`Total clicks before: ${totalClicksBefore}`);
  console.log(`Total clicks after: ${totalClicksAfter}`);
  console.log("Top 25 losing pages:");
  for (const row of rows.slice(0, 25)) {
    console.log(`- [${row.impression_loss}] ${row.url} (${row.recovery_bucket})`);
  }
  console.log("Count by recovery bucket:");
  for (const [bucket, count] of [...bucketCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`- ${bucket}: ${count}`);
  }
}

async function main(): Promise<void> {
  const [beforeContent, afterContent, redirectsContent, crawlContent] = await Promise.all([
    readFile(DEFAULT_BEFORE_PATH, "utf8"),
    readFile(DEFAULT_AFTER_PATH, "utf8"),
    readFile(DEFAULT_REDIRECTS_PATH, "utf8"),
    readFile(DEFAULT_CRAWL_PATH, "utf8")
  ]);

  const beforeRows = parseGscCsv(beforeContent);
  const afterRows = parseGscCsv(afterContent);
  const rules = parseRedirectsYaml(redirectsContent);
  const crawlUrls = parseCrawlCsv(crawlContent);
  const aggregates = buildRecoveryAggregates(beforeRows, afterRows, rules).slice(0, 25);
  const sitemapUrls = await loadSitemapUrls("https://adamandlinds.com/");

  const liveChecks = new Map<string, LiveCheck>();
  const getCheck = async (url: string): Promise<LiveCheck> => {
    const normalized = normalizeSiteUrl(url);
    const existing = liveChecks.get(normalized);
    if (existing) {
      return existing;
    }
    const check = await fetchRedirectChain(normalized);
    liveChecks.set(normalized, check);
    return check;
  };

  const rows: RecoveryRow[] = [];
  for (const aggregate of aggregates) {
    const liveCheck = await getCheck(aggregate.url);
    const oldUrls = [...aggregate.sourceUrls].filter((url) => url !== aggregate.url).sort();
    const aliasUrls = oldUrls.filter((url) => new URL(url).pathname.startsWith("/blog/"));
    const aliasChecks = [];
    for (const aliasUrl of aliasUrls) {
      aliasChecks.push(await getCheck(aliasUrl));
    }

    const beforePosition = formatPosition(aggregate.beforePositionNumerator, aggregate.beforePositionWeight);
    const afterPosition = formatPosition(aggregate.afterPositionNumerator, aggregate.afterPositionWeight);

    rows.push(classifyRecoveryRow({
      url: aggregate.url,
      beforeClicks: aggregate.beforeClicks,
      afterClicks: aggregate.afterClicks,
      beforeImpressions: aggregate.beforeImpressions,
      afterImpressions: aggregate.afterImpressions,
      beforePosition,
      afterPosition,
      oldUrls,
      liveCheck,
      aliasChecks,
      inSitemap: sitemapUrls.has(normalizeSiteUrl(liveCheck.finalUrl)),
      inCrawlCsv: crawlUrls.has(normalizeSiteUrl(aggregate.url))
    }));
  }

  const sortedRows = sortRecoveryRows(rows);
  await writeRecoveryCsv(sortedRows, DEFAULT_OUTPUT_PATH);
  printSummary(beforeRows, afterRows, sortedRows);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
