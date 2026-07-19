import { createHash } from "node:crypto";
import { load as loadHtml } from "cheerio";
import type { AuditRow, FetchResult, PageMetrics, PageType } from "./types.js";

type DuplicateInfo = {
  duplicateType: string;
  duplicateUrls: string[];
  similarity: number | null;
  groupId: string;
};

type Finding = {
  scope: "technical" | "content";
  message: string;
  score: number;
  recommendation: string;
  severeCanonical?: boolean;
};

const EXPECTED_NOINDEX_TYPES = new Set<PageType>(["LEGAL", "UTILITY", "TAG_ARCHIVE", "AUTHOR_ARCHIVE"]);
const LOW_PRIORITY_TYPES = new Set<PageType>(["LEGAL", "UTILITY", "TAG_ARCHIVE", "AUTHOR_ARCHIVE"]);

function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function classifyPageType(url: string, rootUrl: string): PageType {
  const parsed = new URL(url);
  const path = normalizePathname(parsed.pathname.toLowerCase());
  const rootPath = normalizePathname(new URL(rootUrl).pathname.toLowerCase());

  if (path === rootPath || path === "/") {
    return "HOMEPAGE";
  }
  if (/^\/tag\/[^/]+$/.test(path)) {
    return "TAG_ARCHIVE";
  }
  if (/^\/author\/[^/]+$/.test(path)) {
    return "AUTHOR_ARCHIVE";
  }
  if (/(privacy|terms|affiliate-disclosure|disclosure|style-guide|contact|about|cookies|accessibility)/.test(path)) {
    return /(privacy|terms|affiliate-disclosure|disclosure)/.test(path) ? "LEGAL" : "UTILITY";
  }
  if (/^(\/wp-admin|\/wp-login|\/feed|\/search|\/category|\/page\/\d+|\/author)$/.test(path)) {
    return "UTILITY";
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 1 && /^[a-z0-9-]+$/.test(segments[0])) {
    return "CONTENT";
  }
  if (segments.length >= 1 && !["tag", "author"].includes(segments[0])) {
    return "CONTENT";
  }
  return "OTHER";
}

function visibleText($: ReturnType<typeof loadHtml>): string {
  const clone = $.root().clone();
  clone.find("script, style, noscript, svg, template, header, nav, footer").remove();
  return cleanText(clone.text());
}

function normalizeContentText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}

function hashContent(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function slugTokens(url: string): string[] {
  return normalizePathname(new URL(url).pathname)
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .flatMap((segment) => segment.split("-"))
    .filter(Boolean);
}

function tokenSimilarity(a: string, b: string): number {
  const aTokens = a.split(" ").filter(Boolean);
  const bTokens = b.split(" ").filter(Boolean);
  if (aTokens.length === 0 || bTokens.length === 0) {
    return 0;
  }
  const aCounts = new Map<string, number>();
  const bCounts = new Map<string, number>();
  for (const token of aTokens) {
    aCounts.set(token, (aCounts.get(token) ?? 0) + 1);
  }
  for (const token of bTokens) {
    bCounts.set(token, (bCounts.get(token) ?? 0) + 1);
  }
  let overlap = 0;
  for (const [token, count] of aCounts) {
    overlap += Math.min(count, bCounts.get(token) ?? 0);
  }
  return overlap / Math.max(aTokens.length, bTokens.length);
}

function maybeUrlVariant(a: PageMetrics, b: PageMetrics): boolean {
  const aTokens = slugTokens(a.url);
  const bTokens = slugTokens(b.url);
  if (aTokens.length === 0 || bTokens.length === 0) {
    return false;
  }
  const [shorter, longer] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (shorter.length === longer.length) {
    return false;
  }
  const longerSet = new Set(longer);
  return shorter.every((token) => longerSet.has(token)) &&
    normalizePathname(new URL(a.url).pathname) !== normalizePathname(new URL(b.url).pathname);
}

function visibleWordCount(text: string): number {
  return text ? text.split(/\s+/).length : 0;
}

export function extractPageMetrics(result: FetchResult, rootUrl: string): PageMetrics {
  const pageType = classifyPageType(result.url, rootUrl);
  const empty: PageMetrics = {
    url: result.url,
    finalUrl: result.finalUrl,
    status: result.status,
    responseTimeMs: result.responseTimeMs,
    contentType: result.contentType,
    title: "",
    metaDescription: "",
    canonicalUrl: "",
    metaRobots: "",
    indexable: result.status >= 200 && result.status < 300,
    h1Count: 0,
    firstH1: "",
    visibleWordCount: 0,
    normalizedVisibleText: "",
    visibleTextHash: "",
    internalLinkCount: 0,
    externalLinkCount: 0,
    imageCount: 0,
    imagesMissingAltCount: 0,
    pageType,
    fetchError: result.error
  };

  if (result.error || !/text\/html|application\/xhtml\+xml/i.test(result.contentType)) {
    return empty;
  }

  const $ = loadHtml(result.body);
  const metaRobots = cleanText($("meta[name='robots']").attr("content"));
  const canonicalUrl = cleanText($("link[rel='canonical']").attr("href"));

  let internalLinkCount = 0;
  let externalLinkCount = 0;
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }
    try {
      const resolved = new URL(href, result.finalUrl);
      if (["mailto:", "tel:", "javascript:", "file:", "data:"].includes(resolved.protocol)) {
        return;
      }
      if (resolved.hostname === new URL(rootUrl).hostname) {
        internalLinkCount += 1;
      } else {
        externalLinkCount += 1;
      }
    } catch {
      return;
    }
  });

  const h1s = $("h1")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean);
  const images = $("img").toArray();
  const text = visibleText($);
  const normalizedText = normalizeContentText(text);

  return {
    ...empty,
    title: cleanText($("title").text()),
    metaDescription: cleanText($("meta[name='description']").attr("content")),
    canonicalUrl,
    metaRobots,
    indexable: empty.indexable && !/noindex/i.test(metaRobots),
    h1Count: h1s.length,
    firstH1: h1s[0] ?? "",
    visibleWordCount: visibleWordCount(text),
    normalizedVisibleText: normalizedText,
    visibleTextHash: normalizedText ? hashContent(normalizedText) : "",
    internalLinkCount,
    externalLinkCount,
    imageCount: images.length,
    imagesMissingAltCount: images.filter((image) => {
      const alt = $(image).attr("alt");
      return alt == null || cleanText(alt) === "";
    }).length
  };
}

function buildDuplicateMap(metrics: PageMetrics[]): {
  duplicatesByUrl: Map<string, DuplicateInfo[]>;
  exactGroups: number;
  nearGroups: number;
} {
  const duplicatesByUrl = new Map<string, DuplicateInfo[]>();
  let exactGroups = 0;
  let nearGroups = 0;
  let groupNumber = 1;

  const addDuplicate = (urls: string[], duplicateType: string, similarity: number | null): void => {
    const uniqueUrls = [...new Set(urls)].sort();
    if (uniqueUrls.length < 2) {
      return;
    }
    const groupId = `dup-${groupNumber++}`;
    if (duplicateType === "EXACT_CONTENT") {
      exactGroups += 1;
    }
    if (duplicateType === "NEAR_DUPLICATE") {
      nearGroups += 1;
    }
    for (const url of uniqueUrls) {
      const others = uniqueUrls.filter((candidate) => candidate !== url);
      const list = duplicatesByUrl.get(url) ?? [];
      list.push({ duplicateType, duplicateUrls: others, similarity, groupId });
      duplicatesByUrl.set(url, list);
    }
  };

  const byHash = new Map<string, PageMetrics[]>();
  for (const page of metrics) {
    if (!page.visibleTextHash) {
      continue;
    }
    const group = byHash.get(page.visibleTextHash) ?? [];
    group.push(page);
    byHash.set(page.visibleTextHash, group);
  }
  for (const group of byHash.values()) {
    if (group.length > 1) {
      addDuplicate(group.map((page) => page.url), "EXACT_CONTENT", 100);
    }
  }

  const candidates = metrics.filter((page) => page.normalizedVisibleText && page.pageType !== "LEGAL" && page.pageType !== "UTILITY");
  const seenNear = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    for (let inner = index + 1; inner < candidates.length; inner += 1) {
      const a = candidates[index];
      const b = candidates[inner];
      if (a.visibleTextHash && a.visibleTextHash === b.visibleTextHash) {
        continue;
      }
      if (Math.abs(a.visibleWordCount - b.visibleWordCount) > 50) {
        continue;
      }
      const similarity = tokenSimilarity(a.normalizedVisibleText, b.normalizedVisibleText);
      if (similarity >= 0.9) {
        const key = [a.url, b.url].sort().join("::");
        if (!seenNear.has(key)) {
          seenNear.add(key);
          addDuplicate([a.url, b.url], "NEAR_DUPLICATE", Math.round(similarity * 100));
        }
      } else if (maybeUrlVariant(a, b) && similarity >= 0.5) {
        const key = [a.url, b.url].sort().join("::");
        if (!seenNear.has(key)) {
          seenNear.add(key);
          addDuplicate([a.url, b.url], "URL_VARIANT", Math.round(similarity * 100));
        }
      }
    }
  }

  return { duplicatesByUrl, exactGroups, nearGroups };
}

function highestImpact(finding: Finding, current: Finding | null): Finding {
  if (!current || finding.score > current.score) {
    return finding;
  }
  return current;
}

function normalizeComparableUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function buildAuditRows(metrics: PageMetrics[], rootUrl: string): AuditRow[] {
  const titleCounts = new Map<string, number>();
  const crawledByUrl = new Map<string, PageMetrics>();

  for (const page of metrics) {
    crawledByUrl.set(page.url, page);
    if (page.title) {
      titleCounts.set(page.title, (titleCounts.get(page.title) ?? 0) + 1);
    }
  }

  const { duplicatesByUrl } = buildDuplicateMap(metrics);

  const rows = metrics.map((page) => {
    const technicalIssues: string[] = [];
    const contentRisk: string[] = [];
    let priority = 0;
    let highestFinding: Finding | null = null;
    let severeCanonicalProblem = false;

    const addFinding = (finding: Finding): void => {
      if (finding.scope === "technical") {
        technicalIssues.push(finding.message);
      } else {
        contentRisk.push(finding.message);
      }
      priority += finding.score;
      highestFinding = highestImpact(finding, highestFinding);
      if (finding.severeCanonical) {
        severeCanonicalProblem = true;
      }
    };

    if (page.fetchError) {
      addFinding({
        scope: "technical",
        message: `Request failed: ${page.fetchError}`,
        score: 100,
        recommendation: "Retry the request. If it keeps failing, inspect server availability and blocking."
      });
    } else if (page.status >= 500) {
      addFinding({
        scope: "technical",
        message: `Returns HTTP ${page.status}`,
        score: 90,
        recommendation: "Confirm the server error, then restore a valid response or remove the URL from internal links and the sitemap."
      });
    } else if (page.status >= 400) {
      addFinding({
        scope: "technical",
        message: `Returns HTTP ${page.status}`,
        score: 80,
        recommendation: "Confirm whether this URL should exist. Redirect it or restore the page."
      });
    }

    const unexpectedNoindex = !page.indexable && !EXPECTED_NOINDEX_TYPES.has(page.pageType);
    if (unexpectedNoindex) {
      addFinding({
        scope: "technical",
        message: "Unexpected noindex on a crawlable content page",
        score: 70,
        recommendation: "Confirm whether this content page should be indexed. Remove the noindex directive if it should appear in search."
      });
    }

    const duplicateInfos = duplicatesByUrl.get(page.url) ?? [];
    const exactDuplicate = duplicateInfos.find((info) => info.duplicateType === "EXACT_CONTENT");
    const nearDuplicate = duplicateInfos.find((info) => info.duplicateType === "NEAR_DUPLICATE");
    const urlVariant = duplicateInfos.find((info) => info.duplicateType === "URL_VARIANT");

    if (exactDuplicate) {
      addFinding({
        scope: "content",
        message: `Exact duplicate content with ${exactDuplicate.duplicateUrls.join(", ")}`,
        score: 65,
        recommendation: "Choose the preferred URL. Redirect the duplicate or canonicalize it consistently, then remove the duplicate from internal links and the sitemap."
      });
    } else if (nearDuplicate) {
      addFinding({
        scope: "content",
        message: `Near-duplicate content (${nearDuplicate.similarity}% similar) with ${nearDuplicate.duplicateUrls.join(", ")}`,
        score: 55,
        recommendation: "Choose the preferred version, consolidate overlap, and redirect or canonicalize the weaker variant."
      });
    } else if (urlVariant) {
      addFinding({
        scope: "content",
        message: `Possible URL variant overlap with ${urlVariant.duplicateUrls.join(", ")}`,
        score: 20,
        recommendation: "Review whether these URLs represent stale or campaign variants and consolidate them if they target the same intent."
      });
    }

    const duplicateCount = page.title ? titleCounts.get(page.title) ?? 0 : 0;
    if (duplicateCount > 1) {
      addFinding({
        scope: "content",
        message: `Duplicate title used by ${duplicateCount} pages`,
        score: 35,
        recommendation: "Give this page a distinct title that matches its intent."
      });
    }

    if (!page.canonicalUrl && page.pageType === "CONTENT" && page.indexable) {
      addFinding({
        scope: "technical",
        message: "Missing canonical on an indexable content page",
        score: 10,
        recommendation: "Add a self-referencing canonical unless there is a stronger canonical target."
      });
    } else if (page.canonicalUrl) {
      try {
        const resolvedCanonical = new URL(page.canonicalUrl, page.finalUrl).toString();
        const rootHost = new URL(rootUrl).hostname;
        const canonicalHost = new URL(resolvedCanonical).hostname;
        if (canonicalHost !== rootHost) {
          addFinding({
            scope: "technical",
            message: `Canonical points to another host: ${resolvedCanonical}`,
            score: 25,
            recommendation: "Confirm that the cross-host canonical is intentional and necessary.",
            severeCanonical: true
          });
        } else if (normalizeComparableUrl(resolvedCanonical) !== normalizeComparableUrl(page.finalUrl)) {
          addFinding({
            scope: "technical",
            message: `Canonical points to a different same-site URL: ${resolvedCanonical}`,
            score: 10,
            recommendation: "Confirm that this page should consolidate into the canonical target, then align internal links and sitemap entries."
          });
        }

        const canonicalTarget = crawledByUrl.get(resolvedCanonical);
        if (
          canonicalTarget &&
          normalizeComparableUrl(canonicalTarget.finalUrl) !== normalizeComparableUrl(page.finalUrl) &&
          (canonicalTarget.fetchError || canonicalTarget.status >= 400 || !canonicalTarget.indexable)
        ) {
          addFinding({
            scope: "technical",
            message: `Canonical target has issues: ${resolvedCanonical}`,
            score: 15,
            recommendation: "Fix the canonical target or point this page at a stable indexable URL.",
            severeCanonical: true
          });
        }

        if (exactDuplicate && canonicalTarget && normalizeComparableUrl(canonicalTarget.finalUrl) !== normalizeComparableUrl(page.finalUrl)) {
          addFinding({
            scope: "technical",
            message: "Duplicate pages use conflicting canonicals",
            score: 30,
            recommendation: "Pick one preferred canonical URL for the duplicate set and apply it consistently.",
            severeCanonical: true
          });
        }
      } catch {
        addFinding({
          scope: "technical",
          message: "Canonical is invalid",
          score: 15,
          recommendation: "Replace the invalid canonical with a valid same-site canonical.",
          severeCanonical: true
        });
      }
    }

    if (page.pageType === "CONTENT") {
      if (page.visibleWordCount > 0 && page.visibleWordCount < 100) {
        addFinding({
          scope: "content",
          message: `Only ${page.visibleWordCount} visible words`,
          score: 25,
          recommendation: "Review whether this page serves a distinct purpose. Expand, merge, redirect, or remove it rather than adding filler."
        });
      } else if (page.visibleWordCount >= 100 && page.visibleWordCount < 200) {
        addFinding({
          scope: "content",
          message: `${page.visibleWordCount} visible words`,
          score: 15,
          recommendation: "Review whether this page serves a distinct purpose. Expand, merge, redirect, or remove it rather than adding filler."
        });
      } else if (page.visibleWordCount >= 200 && page.visibleWordCount < 300) {
        addFinding({
          scope: "content",
          message: `${page.visibleWordCount} visible words`,
          score: 5,
          recommendation: "Review whether this page serves a distinct purpose. Expand, merge, redirect, or remove it rather than adding filler."
        });
      }

      if (page.h1Count === 0) {
        addFinding({
          scope: "content",
          message: "Missing H1",
          score: 10,
          recommendation: "Add one clear on-page heading."
        });
      }
    }

    if (page.h1Count > 1) {
      addFinding({
        scope: "content",
        message: `Multiple H1s (${page.h1Count})`,
        score: 5,
        recommendation: "Reduce the page to one primary H1 unless the template truly needs more."
      });
    }

    if (!highestFinding && page.imagesMissingAltCount > 0) {
      highestFinding = {
        scope: "content",
        message: "",
        score: 0,
        recommendation: "Add alt text where images carry meaning."
      };
    }

    if (LOW_PRIORITY_TYPES.has(page.pageType) && !page.fetchError && page.status < 400 && !severeCanonicalProblem) {
      priority = Math.min(priority, 10);
    }

    priority = Math.min(100, priority);

    const primaryDuplicate = exactDuplicate ?? nearDuplicate ?? urlVariant;

    return {
      priority,
      url: page.url,
      page_type: page.pageType,
      status: page.status ? String(page.status) : "FAILED",
      indexable: page.indexable ? "yes" : "no",
      title: page.title,
      h1: page.firstH1,
      word_count: page.visibleWordCount,
      technical_issues: technicalIssues.join("; "),
      content_risk: contentRisk.join("; "),
      recommended_action: highestFinding?.recommendation ?? "Review this page manually.",
      response_time_ms: page.responseTimeMs,
      canonical: page.canonicalUrl,
      internal_links: page.internalLinkCount,
      external_links: page.externalLinkCount,
      images_missing_alt: page.imagesMissingAltCount,
      duplicate_type: primaryDuplicate?.duplicateType ?? "",
      duplicate_urls: primaryDuplicate?.duplicateUrls.join(", ") ?? "",
      similarity: primaryDuplicate?.similarity ? String(primaryDuplicate.similarity) : ""
    };
  });

  return rows.sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url));
}
