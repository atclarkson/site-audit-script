import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { load as loadHtml } from "cheerio";
import { fetchWithLimit } from "./crawl.js";
import type { AuditOptions } from "./types.js";
import { buildComparisonRows, normalizeSiteUrl, parseCsvLine, parseGscCsv, parseRedirectsYaml } from "./compare.js";

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_LIMIT = 50;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONTENT_CHARS = 16000;
const MAX_PROMPT_OUTPUT_TOKENS = 2500;
const ANTHROPIC_VERSION = "2023-06-01";
const CACHE_DIR = "output/cache";
const OUTPUT_PATH = "output/content-triage.csv";
const MODEL_PRICING = {
  inputPerMillion: 3,
  outputPerMillion: 15
};

const CLAUDE_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "page_purpose",
    "primary_search_intent",
    "content_cluster",
    "distinctiveness_score",
    "firsthand_evidence_score",
    "specificity_score",
    "commercial_pressure_score",
    "templated_language_score",
    "overlap_risk_score",
    "trust_evidence_score",
    "likely_user_value_score",
    "strengths",
    "weaknesses",
    "evidence_missing",
    "overlapping_topics",
    "recommended_disposition",
    "recommended_action",
    "confidence"
  ],
  properties: {
    page_purpose: { type: "string" },
    primary_search_intent: { type: "string" },
    content_cluster: { type: "string" },
    distinctiveness_score: { type: "integer" },
    firsthand_evidence_score: { type: "integer" },
    specificity_score: { type: "integer" },
    commercial_pressure_score: { type: "integer" },
    templated_language_score: { type: "integer" },
    overlap_risk_score: { type: "integer" },
    trust_evidence_score: { type: "integer" },
    likely_user_value_score: { type: "integer" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    evidence_missing: { type: "array", items: { type: "string" } },
    overlapping_topics: { type: "array", items: { type: "string" } },
    recommended_disposition: {
      type: "string",
      enum: ["KEEP", "IMPROVE", "REBUILD", "MERGE_REVIEW", "NOINDEX_REVIEW", "REMOVE_REVIEW"]
    },
    recommended_action: { type: "string" },
    confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] }
  }
} as const;

const REQUEST_OPTIONS: AuditOptions = {
  limit: DEFAULT_LIMIT,
  outputPath: OUTPUT_PATH,
  concurrency: DEFAULT_CONCURRENCY,
  timeoutMs: 15_000,
  maxBodyBytes: 5 * 1024 * 1024,
  userAgent: "AdamAndLindsSiteAudit/1.0"
};

type CrawlRow = {
  url: string;
  pageType: string;
  status: string;
  indexable: string;
  title: string;
  technicalIssues: string;
};

type RecoveryRow = {
  url: string;
  finalUrl: string;
  beforeClicks: number;
  afterClicks: number;
  clickLoss: number;
  beforeImpressions: number;
  afterImpressions: number;
  impressionLoss: number;
  technicalIssue: string;
  recoveryBucket: string;
};

type CandidateRow = {
  url: string;
  finalUrl: string;
  beforeClicks: number;
  afterClicks: number;
  clickLoss: number;
  beforeImpressions: number;
  afterImpressions: number;
  impressionLoss: number;
  compareBeforeClicks: number;
  compareAfterClicks: number;
  compareClickLoss: number;
  compareBeforeImpressions: number;
  compareAfterImpressions: number;
  compareImpressionLoss: number;
  title: string;
  technicalIssue: string;
  recoveryBucket: string;
  contentCluster: string;
  selectionScore: number;
};

type FetchedPage = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  contentHash: string;
  technicalIssue: string;
};

type ClaudeAnalysis = {
  page_purpose: string;
  primary_search_intent: string;
  content_cluster: string;
  distinctiveness_score: number;
  firsthand_evidence_score: number;
  specificity_score: number;
  commercial_pressure_score: number;
  templated_language_score: number;
  overlap_risk_score: number;
  trust_evidence_score: number;
  likely_user_value_score: number;
  strengths: string[];
  weaknesses: string[];
  evidence_missing: string[];
  overlapping_topics: string[];
  recommended_disposition: "KEEP" | "IMPROVE" | "REBUILD" | "MERGE_REVIEW" | "NOINDEX_REVIEW" | "REMOVE_REVIEW";
  recommended_action: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
};

type CacheEntry = {
  model: string;
  url: string;
  contentHash: string;
  result: ClaudeAnalysis;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  analyzedAt: string;
};

type TriageRow = {
  priority: number;
  url: string;
  final_url: string;
  content_cluster: string;
  before_clicks: number;
  after_clicks: number;
  click_loss: number;
  before_impressions: number;
  after_impressions: number;
  impression_loss: number;
  page_purpose: string;
  primary_search_intent: string;
  distinctiveness_score: number;
  firsthand_evidence_score: number;
  specificity_score: number;
  commercial_pressure_score: number;
  templated_language_score: number;
  overlap_risk_score: number;
  trust_evidence_score: number;
  likely_user_value_score: number;
  overlap_with_urls: string;
  overlap_summary: string;
  strengths: string;
  weaknesses: string;
  evidence_missing: string;
  recommended_disposition: string;
  recommended_action: string;
  confidence: string;
  technical_issue: string;
  content_hash: string;
  analyzed_at: string;
};

type TriageStats = {
  candidateCount: number;
  selectedCount: number;
  cachedReused: number;
  sentToClaude: number;
  failedAnalyses: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  actualInputTokens: number;
  actualOutputTokens: number;
};

function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsvByHeader(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  return {
    headers: parseCsvLine(lines[0]),
    rows: lines.slice(1).map(parseCsvLine)
  };
}

function parseSiteAuditCsv(content: string): Map<string, CrawlRow> {
  const { headers, rows } = parseCsvByHeader(content);
  const urlIndex = headers.indexOf("url");
  const pageTypeIndex = headers.indexOf("page_type");
  const statusIndex = headers.indexOf("status");
  const indexableIndex = headers.indexOf("indexable");
  const titleIndex = headers.indexOf("title");
  const technicalIndex = headers.indexOf("technical_issues");
  const map = new Map<string, CrawlRow>();
  for (const row of rows) {
    const url = row[urlIndex];
    if (!url) {
      continue;
    }
    map.set(normalizeSiteUrl(url), {
      url: normalizeSiteUrl(url),
      pageType: row[pageTypeIndex] ?? "",
      status: row[statusIndex] ?? "",
      indexable: row[indexableIndex] ?? "",
      title: row[titleIndex] ?? "",
      technicalIssues: row[technicalIndex] ?? ""
    });
  }
  return map;
}

function parseRecoveryCsv(content: string): RecoveryRow[] {
  const { headers, rows } = parseCsvByHeader(content);
  const index = (name: string) => headers.indexOf(name);
  return rows.map((row) => ({
    url: normalizeSiteUrl(row[index("url")]),
    finalUrl: normalizeSiteUrl(row[index("final_url")] || row[index("url")]),
    beforeClicks: toNumber(row[index("before_clicks")]),
    afterClicks: toNumber(row[index("after_clicks")]),
    clickLoss: toNumber(row[index("click_loss")]),
    beforeImpressions: toNumber(row[index("before_impressions")]),
    afterImpressions: toNumber(row[index("after_impressions")]),
    impressionLoss: toNumber(row[index("impression_loss")]),
    technicalIssue: row[index("technical_issue")] ?? "",
    recoveryBucket: row[index("recovery_bucket")] ?? ""
  }));
}

function parseArgs(args: string[]): { limit: number; refresh: boolean } {
  let limit = DEFAULT_LIMIT;
  let refresh = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--limit") {
      limit = Number(args[index + 1]);
      index += 1;
    } else if (args[index] === "--refresh") {
      refresh = true;
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  return { limit, refresh };
}

function inferCluster(url: string, title: string, content = ""): string {
  const haystack = `${url} ${title} ${content}`.toLowerCase();
  if (haystack.includes("holafly") && haystack.includes("china")) {
    return "HOLAFly_CHINA";
  }
  if (haystack.includes("holafly") && /(japan|italy|spain|greece|mexico|europe|thailand|egypt|serbia|philippines|taiwan)/.test(haystack)) {
    return "HOLAFly_DESTINATION";
  }
  if (haystack.includes("holafly")) {
    return "HOLAFly_GENERAL";
  }
  if (haystack.includes("klook")) {
    return "KLOOK";
  }
  if (haystack.includes("teamlab")) {
    return "TEAMLAB";
  }
  if (haystack.includes("esim")) {
    return "ESIM_GENERAL";
  }
  if (haystack.includes("worldschool")) {
    return "WORLDSCHOOLING";
  }
  if (/(itinerary|guide|things to do|family travel|with kids|taipei|tokyo|balkans|travel guide|day trip)/.test(haystack)) {
    return "DESTINATION_TRAVEL";
  }
  if (/(review|honest|our|we|family)/.test(haystack)) {
    return "PERSONAL_TRAVEL";
  }
  if (/(discount|coupon|promo|deal|affiliate)/.test(haystack)) {
    return "OTHER_AFFILIATE";
  }
  return "OTHER";
}

function isCommercial(title: string, url: string): boolean {
  return /(discount|coupon|promo|deal|esim|holafly|klook|review|best)/i.test(`${title} ${url}`);
}

export function selectTriageCandidates(params: {
  recoveryRows: RecoveryRow[];
  compareRows: ReturnType<typeof buildComparisonRows>;
  crawlRows: Map<string, CrawlRow>;
  limit: number;
}): CandidateRow[] {
  const compareMap = new Map(params.compareRows.map((row) => [normalizeSiteUrl(row.url), row]));
  const contentRows = params.recoveryRows.filter((row) => {
    const crawl = params.crawlRows.get(row.url);
    return crawl?.pageType === "CONTENT";
  });

  const provisional = contentRows.map((row) => {
    const crawl = params.crawlRows.get(row.url)!;
    const compare = compareMap.get(row.url);
    return {
      url: row.url,
      finalUrl: row.finalUrl,
      beforeClicks: row.beforeClicks,
      afterClicks: row.afterClicks,
      clickLoss: row.clickLoss,
      beforeImpressions: row.beforeImpressions,
      afterImpressions: row.afterImpressions,
      impressionLoss: row.impressionLoss,
      compareBeforeClicks: compare?.before_clicks ?? 0,
      compareAfterClicks: compare?.after_clicks ?? 0,
      compareClickLoss: Math.max(0, (compare?.before_clicks ?? 0) - (compare?.after_clicks ?? 0)),
      compareBeforeImpressions: compare?.before_impressions ?? 0,
      compareAfterImpressions: compare?.after_impressions ?? 0,
      compareImpressionLoss: Math.max(0, (compare?.before_impressions ?? 0) - (compare?.after_impressions ?? 0)),
      title: crawl.title,
      technicalIssue: row.technicalIssue || crawl.technicalIssues,
      recoveryBucket: row.recoveryBucket,
      contentCluster: inferCluster(row.url, crawl.title),
      selectionScore: 0
    };
  });

  const clusterLoss = new Map<string, number>();
  for (const row of provisional) {
    clusterLoss.set(row.contentCluster, (clusterLoss.get(row.contentCluster) ?? 0) + row.impressionLoss);
  }

  const max48hLoss = Math.max(1, ...provisional.map((row) => row.impressionLoss));
  const max28dLoss = Math.max(1, ...provisional.map((row) => row.compareImpressionLoss));
  const maxClusterLoss = Math.max(1, ...clusterLoss.values());

  const scored = provisional.map((row) => {
    const traffic48 = row.impressionLoss / max48hLoss;
    const traffic28 = row.compareImpressionLoss / max28dLoss;
    const clusterHit = (clusterLoss.get(row.contentCluster) ?? 0) / maxClusterLoss;
    const technical = row.technicalIssue ? 0.2 : 0;
    const commercial = isCommercial(row.title, row.url) ? 0.15 : 0;
    const score = traffic48 * 0.55 + traffic28 * 0.2 + clusterHit * 0.1 + technical + commercial;
    return {
      ...row,
      selectionScore: score
    };
  });

  return scored
    .sort((a, b) => b.selectionScore - a.selectionScore || b.impressionLoss - a.impressionLoss || a.url.localeCompare(b.url))
    .slice(0, params.limit);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractMainContent(html: string): { title: string; content: string } {
  const $ = loadHtml(html);
  $("script, style, noscript, svg, template, header, nav, footer, aside, form, button, [id*='cookie'], [class*='cookie'], [class*='newsletter'], [class*='subscribe']").remove();
  const root = $("article").first().length > 0 ? $("article").first() : $("main").first().length > 0 ? $("main").first() : $("body");
  const parts: string[] = [];
  root.find("h1,h2,h3,p,li").each((_, element) => {
    const text = cleanText($(element).text());
    if (text) {
      parts.push(text);
    }
  });
  const title = cleanText($("title").text());
  const content = parts.join("\n").slice(0, MAX_CONTENT_CHARS);
  return { title, content };
}

async function fetchPageContent(url: string): Promise<FetchedPage> {
  const fetched = await fetchWithLimit(url, REQUEST_OPTIONS);
  const technical: string[] = [];
  if (fetched.error) {
    technical.push(`Request failed: ${fetched.error}`);
  }
  if (fetched.status >= 400) {
    technical.push(`Returns HTTP ${fetched.status}`);
  }
  const { title, content } = extractMainContent(fetched.body || "");
  const contentHash = createHash("sha1")
    .update(`${fetched.finalUrl}\n${title}\n${content}`)
    .digest("hex");

  return {
    requestedUrl: url,
    finalUrl: normalizeSiteUrl(fetched.finalUrl || url),
    title,
    content,
    contentHash,
    technicalIssue: technical.join("; ")
  };
}

function getCachePath(url: string): string {
  const key = createHash("sha1").update(url).digest("hex");
  return join(CACHE_DIR, `${key}.json`);
}

export function shouldReuseCache(entry: CacheEntry | null, model: string, contentHash: string): boolean {
  return Boolean(entry && entry.model === model && entry.contentHash === contentHash);
}

async function readCache(url: string): Promise<CacheEntry | null> {
  try {
    const content = await readFile(getCachePath(url), "utf8");
    return JSON.parse(content) as CacheEntry;
  } catch {
    return null;
  }
}

async function writeCache(url: string, entry: CacheEntry): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(getCachePath(url), JSON.stringify(entry, null, 2), "utf8");
}

export function parseClaudeJson(text: string): ClaudeAnalysis {
  const parsed = JSON.parse(text) as ClaudeAnalysis;
  const normalizeScore = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Claude response field ${field} must be a finite number`);
    }
    return Math.min(100, Math.max(0, Math.round(value)));
  };
  return {
    ...parsed,
    distinctiveness_score: normalizeScore(parsed.distinctiveness_score, "distinctiveness_score"),
    firsthand_evidence_score: normalizeScore(parsed.firsthand_evidence_score, "firsthand_evidence_score"),
    specificity_score: normalizeScore(parsed.specificity_score, "specificity_score"),
    commercial_pressure_score: normalizeScore(parsed.commercial_pressure_score, "commercial_pressure_score"),
    templated_language_score: normalizeScore(parsed.templated_language_score, "templated_language_score"),
    overlap_risk_score: normalizeScore(parsed.overlap_risk_score, "overlap_risk_score"),
    trust_evidence_score: normalizeScore(parsed.trust_evidence_score, "trust_evidence_score"),
    likely_user_value_score: normalizeScore(parsed.likely_user_value_score, "likely_user_value_score"),
    strengths: parsed.strengths ?? [],
    weaknesses: parsed.weaknesses ?? [],
    evidence_missing: parsed.evidence_missing ?? [],
    overlapping_topics: parsed.overlapping_topics ?? []
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildPrompt(candidate: CandidateRow, page: FetchedPage): string {
  return [
    "You are evaluating a travel content page on a site that suffered a sitewide Google visibility collapse after a core update.",
    "Do not claim knowledge of Google's private ranking systems.",
    "Return strict JSON only.",
    "Allowed recommended_disposition values: KEEP, IMPROVE, REBUILD, MERGE_REVIEW, NOINDEX_REVIEW, REMOVE_REVIEW.",
    "Judge whether the page would deserve to exist without affiliate commission. Look for firsthand travel/use/testing evidence. Distinguish specificity from generic claims. Identify repetitive promotional framing or keyword templates. Do not recommend filler.",
    `URL: ${candidate.url}`,
    `Final URL: ${page.finalUrl}`,
    `Cluster hint: ${candidate.contentCluster}`,
    `48h clicks lost: ${candidate.clickLoss}, 48h impressions lost: ${candidate.impressionLoss}`,
    `28d clicks lost: ${candidate.compareClickLoss}, 28d impressions lost: ${candidate.compareImpressionLoss}`,
    `Technical issue context: ${candidate.technicalIssue || "none"}`,
    `Page title: ${page.title || candidate.title}`,
    "Return JSON with keys: page_purpose, primary_search_intent, content_cluster, distinctiveness_score, firsthand_evidence_score, specificity_score, commercial_pressure_score, templated_language_score, overlap_risk_score, trust_evidence_score, likely_user_value_score, strengths, weaknesses, evidence_missing, overlapping_topics, recommended_disposition, recommended_action, confidence.",
    `Page content:\n${page.content}`
  ].join("\n\n");
}

type ClaudeApiResponse = {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function parseClaudeResponse(model: string, json: ClaudeApiResponse): { result: ClaudeAnalysis; usage?: { input_tokens?: number; output_tokens?: number } } {
  const textBlocks = json.content?.filter((item) => item.type === "text" && typeof item.text === "string") ?? [];
  const text = textBlocks.map((item) => item.text ?? "").join("\n").trim();

  if (json.stop_reason === "max_tokens") {
    throw new Error(`Anthropic response hit max_tokens for model ${model}; stop_reason: ${json.stop_reason}; returned text: ${text}`);
  }

  if (!text) {
    const blockTypes = json.content?.map((item) => item.type).join(", ") ?? "";
    throw new Error(`Anthropic response missing text for model ${model}; stop_reason: ${json.stop_reason ?? "unknown"}; content block types: ${blockTypes}`);
  }

  return {
    result: parseClaudeJson(text),
    usage: json.usage
  };
}

async function callClaude(apiKey: string, model: string, prompt: string): Promise<{ result: ClaudeAnalysis; usage?: { input_tokens?: number; output_tokens?: number } }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_PROMPT_OUTPUT_TOKENS,
      output_config: {
        format: {
          type: "json_schema",
          schema: CLAUDE_ANALYSIS_SCHEMA
        }
      },
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Anthropic request failed for model ${model}: HTTP ${response.status}; body: ${responseBody}`);
  }

  const json = await response.json() as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return parseClaudeResponse(model, json);
}

async function analyzeCandidate(
  candidate: CandidateRow,
  apiKey: string,
  model: string,
  refresh: boolean,
  stats: TriageStats
): Promise<{ candidate: CandidateRow; page: FetchedPage; analysis: ClaudeAnalysis; analyzedAt: string }> {
  const page = await fetchPageContent(candidate.finalUrl);
  const cached = refresh ? null : await readCache(candidate.url);
  if (shouldReuseCache(cached, model, page.contentHash)) {
    stats.cachedReused += 1;
    return {
      candidate,
      page,
      analysis: cached!.result,
      analyzedAt: cached!.analyzedAt
    };
  }

  const prompt = buildPrompt(candidate, page);
  stats.estimatedInputTokens += estimateTokens(prompt);
  stats.estimatedOutputTokens += MAX_PROMPT_OUTPUT_TOKENS;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await callClaude(apiKey, model, prompt);
      stats.sentToClaude += 1;
      stats.actualInputTokens += response.usage?.input_tokens ?? 0;
      stats.actualOutputTokens += response.usage?.output_tokens ?? 0;
      const analyzedAt = new Date().toISOString();
      await writeCache(candidate.url, {
        model,
        url: candidate.url,
        contentHash: page.contentHash,
        result: response.result,
        usage: response.usage,
        analyzedAt
      });
      return { candidate, page, analysis: response.result, analyzedAt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  stats.failedAnalyses += 1;
  throw lastError ?? new Error(`Analysis failed for ${candidate.url}`);
}

async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function similarityScore(a: string, b: string): number {
  const aTokens = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const bTokens = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function addOverlap(results: Array<{ candidate: CandidateRow; page: FetchedPage; analysis: ClaudeAnalysis; analyzedAt: string }>): Map<string, { urls: string[]; summary: string }> {
  const byCluster = new Map<string, Array<{ candidate: CandidateRow; page: FetchedPage; analysis: ClaudeAnalysis }>>();
  for (const result of results) {
    const cluster = result.analysis.content_cluster || result.candidate.contentCluster;
    const group = byCluster.get(cluster) ?? [];
    group.push(result);
    byCluster.set(cluster, group);
  }

  const overlapMap = new Map<string, { urls: string[]; summary: string }>();
  for (const group of byCluster.values()) {
    for (const item of group) {
      const related = group
        .filter((other) => other.candidate.url !== item.candidate.url)
        .map((other) => ({
          url: other.candidate.url,
          score: similarityScore(
            `${item.page.title} ${item.page.content.slice(0, 1000)}`,
            `${other.page.title} ${other.page.content.slice(0, 1000)}`
          )
        }))
        .filter((other) => other.score >= 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      overlapMap.set(item.candidate.url, {
        urls: related.map((entry) => entry.url),
        summary: related.length > 0
          ? `Potential overlap within ${item.analysis.content_cluster || item.candidate.contentCluster}: ${related.map((entry) => entry.url).join("; ")}`
          : ""
      });
    }
  }
  return overlapMap;
}

function computePriority(result: {
  candidate: CandidateRow;
  analysis: ClaudeAnalysis;
}): number {
  if (result.candidate.technicalIssue) {
    return 100;
  }
  const trafficLoss = Math.min(100, result.candidate.impressionLoss / 100 + result.candidate.clickLoss * 2 + result.candidate.compareImpressionLoss / 500);
  const lowValue = (100 - result.analysis.likely_user_value_score + 100 - result.analysis.distinctiveness_score) / 2;
  const commercialRisk = (result.analysis.commercial_pressure_score + result.analysis.templated_language_score) / 2;
  const overlapRisk = result.analysis.overlap_risk_score;
  const evidenceWeakness = (100 - result.analysis.firsthand_evidence_score + 100 - result.analysis.trust_evidence_score) / 2;
  return Math.round(
    Math.min(
      100,
      trafficLoss * 0.45 +
      lowValue * 0.2 +
      commercialRisk * 0.15 +
      overlapRisk * 0.1 +
      evidenceWeakness * 0.1
    )
  );
}

export function sortTriageRows(rows: TriageRow[]): TriageRow[] {
  return [...rows].sort((a, b) => b.priority - a.priority || b.impression_loss - a.impression_loss || a.url.localeCompare(b.url));
}

function joinList(values: string[]): string {
  return values.filter(Boolean).join("; ");
}

async function writeCsv(rows: TriageRow[]): Promise<void> {
  await mkdir("output", { recursive: true });
  const header = [
    "priority",
    "url",
    "final_url",
    "content_cluster",
    "before_clicks",
    "after_clicks",
    "click_loss",
    "before_impressions",
    "after_impressions",
    "impression_loss",
    "page_purpose",
    "primary_search_intent",
    "distinctiveness_score",
    "firsthand_evidence_score",
    "specificity_score",
    "commercial_pressure_score",
    "templated_language_score",
    "overlap_risk_score",
    "trust_evidence_score",
    "likely_user_value_score",
    "overlap_with_urls",
    "overlap_summary",
    "strengths",
    "weaknesses",
    "evidence_missing",
    "recommended_disposition",
    "recommended_action",
    "confidence",
    "technical_issue",
    "content_hash",
    "analyzed_at"
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const escaped = header.map((key) => {
      const value = String(row[key as keyof TriageRow] ?? "");
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
    });
    lines.push(escaped.join(","));
  }
  await writeFile(OUTPUT_PATH, `${lines.join("\n")}\n`, "utf8");
}

function estimateCost(stats: TriageStats): string {
  if (!MODEL_PRICING) {
    return "";
  }
  const inputCost = (stats.actualInputTokens / 1_000_000) * MODEL_PRICING.inputPerMillion;
  const outputCost = (stats.actualOutputTokens / 1_000_000) * MODEL_PRICING.outputPerMillion;
  return `$${(inputCost + outputCost).toFixed(4)}`;
}

function printSummary(rows: TriageRow[], stats: TriageStats): void {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.recommended_disposition, (counts.get(row.recommended_disposition) ?? 0) + 1);
  }
  console.log(`Candidate content pages: ${stats.candidateCount}`);
  console.log(`Pages selected: ${stats.selectedCount}`);
  console.log(`Cached results reused: ${stats.cachedReused}`);
  console.log(`Pages sent to Claude: ${stats.sentToClaude}`);
  console.log(`Failed analyses: ${stats.failedAnalyses}`);
  console.log(`Estimated input tokens: ${stats.estimatedInputTokens}`);
  console.log(`Estimated output tokens: ${stats.estimatedOutputTokens}`);
  console.log(`Actual input tokens: ${stats.actualInputTokens}`);
  console.log(`Actual output tokens: ${stats.actualOutputTokens}`);
  if (MODEL_PRICING) {
    console.log(`Estimated cost: ${estimateCost(stats)}`);
  }
  console.log("Counts by recommended disposition:");
  for (const [disposition, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`- ${disposition}: ${count}`);
  }
  console.log("Top 25 recovery priorities:");
  for (const row of rows.slice(0, 25)) {
    console.log(`- [${row.priority}] ${row.url}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for npm run triage");
  }

  const { limit, refresh } = parseArgs(process.argv.slice(2));
  const model = DEFAULT_MODEL;
  const [aprilContent, julyContent, redirectsContent, beforeContent, afterContent, crawlContent, recoveryContent] = await Promise.all([
    readFile("input/april-2day.csv", "utf8"),
    readFile("input/july-2day.csv", "utf8"),
    readFile("input/redirects.yaml", "utf8"),
    readFile("input/gsc-before.csv", "utf8"),
    readFile("input/gsc-after.csv", "utf8"),
    readFile("output/site-audit.csv", "utf8"),
    readFile("output/recovery-report.csv", "utf8")
  ]);

  const redirects = parseRedirectsYaml(redirectsContent);
  const recoveryRows = parseRecoveryCsv(recoveryContent);
  const crawlRows = parseSiteAuditCsv(crawlContent);
  const compareRows = buildComparisonRows(parseGscCsv(beforeContent), parseGscCsv(afterContent), redirects);
  const candidateRows = selectTriageCandidates({
    recoveryRows,
    compareRows,
    crawlRows,
    limit,
  });

  const stats: TriageStats = {
    candidateCount: [...crawlRows.values()].filter((row) => row.pageType === "CONTENT").length,
    selectedCount: candidateRows.length,
    cachedReused: 0,
    sentToClaude: 0,
    failedAnalyses: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0
  };

  const _sanity48h = [parseGscCsv(aprilContent), parseGscCsv(julyContent)];
  void _sanity48h;

  const analyzed = await mapLimit(candidateRows, DEFAULT_CONCURRENCY, (candidate) => analyzeCandidate(candidate, apiKey, model, refresh, stats));
  const overlapMap = addOverlap(analyzed);

  const rows = sortTriageRows(analyzed.map((result) => {
    const overlap = overlapMap.get(result.candidate.url) ?? { urls: [], summary: "" };
    const priority = computePriority(result);
    return {
      priority,
      url: result.candidate.url,
      final_url: result.page.finalUrl,
      content_cluster: result.analysis.content_cluster || result.candidate.contentCluster,
      before_clicks: result.candidate.beforeClicks,
      after_clicks: result.candidate.afterClicks,
      click_loss: result.candidate.clickLoss,
      before_impressions: result.candidate.beforeImpressions,
      after_impressions: result.candidate.afterImpressions,
      impression_loss: result.candidate.impressionLoss,
      page_purpose: result.analysis.page_purpose,
      primary_search_intent: result.analysis.primary_search_intent,
      distinctiveness_score: result.analysis.distinctiveness_score,
      firsthand_evidence_score: result.analysis.firsthand_evidence_score,
      specificity_score: result.analysis.specificity_score,
      commercial_pressure_score: result.analysis.commercial_pressure_score,
      templated_language_score: result.analysis.templated_language_score,
      overlap_risk_score: result.analysis.overlap_risk_score,
      trust_evidence_score: result.analysis.trust_evidence_score,
      likely_user_value_score: result.analysis.likely_user_value_score,
      overlap_with_urls: joinList(overlap.urls),
      overlap_summary: overlap.summary,
      strengths: joinList(result.analysis.strengths),
      weaknesses: joinList(result.analysis.weaknesses),
      evidence_missing: joinList(result.analysis.evidence_missing),
      recommended_disposition: result.analysis.recommended_disposition,
      recommended_action: result.analysis.recommended_action,
      confidence: result.analysis.confidence,
      technical_issue: [result.candidate.technicalIssue, result.page.technicalIssue].filter(Boolean).join("; "),
      content_hash: result.page.contentHash,
      analyzed_at: result.analyzedAt
    };
  }));

  await writeCsv(rows);
  printSummary(rows, stats);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
