import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditRows, extractPageMetrics } from "../src/analyze.js";
import { normalizeUrl, parseSitemapXml } from "../src/crawl.js";
import { printSummary } from "../src/output.js";
import type { FetchResult, PageMetrics } from "../src/types.js";

function makePage(overrides: Partial<PageMetrics> = {}): PageMetrics {
  return {
    url: "https://example.com/page",
    finalUrl: "https://example.com/page",
    status: 200,
    responseTimeMs: 50,
    contentType: "text/html",
    title: "Example Page",
    metaDescription: "",
    canonicalUrl: "https://example.com/page",
    metaRobots: "",
    indexable: true,
    h1Count: 1,
    firstH1: "Heading",
    visibleWordCount: 500,
    normalizedVisibleText: "alpha beta gamma delta",
    visibleTextHash: "hash-1",
    internalLinkCount: 1,
    externalLinkCount: 0,
    imageCount: 0,
    imagesMissingAltCount: 0,
    pageType: "CONTENT",
    ...overrides
  };
}

test("normalizeUrl removes fragments and normalizes host and slash", () => {
  assert.equal(normalizeUrl("HTTPS://Example.com/path/#section"), "https://example.com/path");
  assert.equal(normalizeUrl("/about/", "https://example.com/base"), "https://example.com/about");
  assert.equal(normalizeUrl("mailto:test@example.com"), null);
});

test("parseSitemapXml reads sitemap index and url set loc values", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <sitemapindex>
      <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-blog.xml</loc></sitemap>
    </sitemapindex>
    <urlset>
      <url><loc>https://example.com/</loc></url>
    </urlset>`;
  assert.deepEqual(parseSitemapXml(xml), [
    "https://example.com/sitemap-pages.xml",
    "https://example.com/sitemap-blog.xml",
    "https://example.com/"
  ]);
});

test("extractPageMetrics pulls key HTML fields and visible word count", () => {
  const html = `
    <html>
      <head>
        <title>Example Page</title>
        <meta name="description" content="Summary">
        <meta name="robots" content="index,follow">
        <link rel="canonical" href="https://example.com/page">
      </head>
      <body>
        <header>Skip me</header>
        <h1>Main heading</h1>
        <p>One two three four five six seven eight nine ten.</p>
        <a href="/internal">Internal</a>
        <a href="https://offsite.test">External</a>
        <img src="/a.jpg" alt="">
        <img src="/b.jpg" alt="Alt text">
      </body>
    </html>
  `;
  const result: FetchResult = {
    url: "https://example.com/page",
    finalUrl: "https://example.com/page",
    status: 200,
    contentType: "text/html",
    responseTimeMs: 123,
    body: html
  };
  const page = extractPageMetrics(result, "https://example.com/");
  assert.equal(page.title, "Example Page");
  assert.equal(page.firstH1, "Main heading");
  assert.equal(page.internalLinkCount, 1);
  assert.equal(page.externalLinkCount, 1);
  assert.equal(page.imagesMissingAltCount, 1);
  assert.equal(page.canonicalUrl, "https://example.com/page");
  assert.ok(page.visibleWordCount >= 12);
  assert.equal(page.pageType, "CONTENT");
  assert.ok(page.visibleTextHash);
});

test("legal noindex pages are not prioritized", () => {
  const rows = buildAuditRows([
    makePage({
      url: "https://example.com/privacy-policy",
      finalUrl: "https://example.com/privacy-policy",
      canonicalUrl: "https://example.com/privacy-policy",
      indexable: false,
      metaRobots: "noindex",
      pageType: "LEGAL",
      visibleTextHash: "hash-legal",
      normalizedVisibleText: "privacy terms legal disclosure"
    })
  ], "https://example.com/");
  assert.equal(rows[0].page_type, "LEGAL");
  assert.equal(rows[0].priority, 0);
  assert.doesNotMatch(rows[0].technical_issues, /noindex/i);
});

test("tag archives do not receive thin-content findings", () => {
  const rows = buildAuditRows([
    makePage({
      url: "https://example.com/tag/japan",
      finalUrl: "https://example.com/tag/japan",
      canonicalUrl: "https://example.com/tag/japan",
      pageType: "TAG_ARCHIVE",
      visibleWordCount: 50,
      visibleTextHash: "hash-tag",
      normalizedVisibleText: "japan archive"
    })
  ], "https://example.com/root");
  assert.equal(rows[0].priority, 0);
  assert.doesNotMatch(rows[0].content_risk, /visible words/i);
});

test("image alt warnings add zero priority", () => {
  const rows = buildAuditRows([
    makePage({
      imagesMissingAltCount: 3,
      visibleTextHash: "hash-alt"
    })
  ], "https://example.com/");
  assert.equal(rows[0].priority, 0);
  assert.equal(rows[0].content_risk, "");
  assert.match(rows[0].recommended_action, /alt text/i);
});

test("exact duplicate content is detected", () => {
  const rows = buildAuditRows([
    makePage({ url: "https://example.com/a", finalUrl: "https://example.com/a", canonicalUrl: "https://example.com/a", visibleTextHash: "same-hash", normalizedVisibleText: "same content words" }),
    makePage({ url: "https://example.com/b", finalUrl: "https://example.com/b", canonicalUrl: "https://example.com/b", title: "Other", visibleTextHash: "same-hash", normalizedVisibleText: "same content words" })
  ], "https://example.com/");
  assert.equal(rows[0].duplicate_type, "EXACT_CONTENT");
  assert.match(rows[0].duplicate_urls, /https:\/\/example\.com\//);
  assert.equal(rows[0].similarity, "100");
});

test("exact duplicate content-to-tag pairs are capped at priority 40", () => {
  const rows = buildAuditRows([
    makePage({ url: "https://example.com/japan", finalUrl: "https://example.com/japan", canonicalUrl: "https://example.com/japan", pageType: "CONTENT", title: "Japan", visibleTextHash: "same-hash", normalizedVisibleText: "same content words" }),
    makePage({ url: "https://example.com/tag/japan", finalUrl: "https://example.com/tag/japan", canonicalUrl: "https://example.com/tag/japan", pageType: "TAG_ARCHIVE", title: "Japan", visibleTextHash: "same-hash", normalizedVisibleText: "same content words" })
  ], "https://example.com/");
  assert.equal(rows[0].priority, 40);
  assert.equal(rows[1].priority, 10);
});

test("near-duplicate analysis only compares content pages", () => {
  const rows = buildAuditRows([
    makePage({ url: "https://example.com/a", finalUrl: "https://example.com/a", canonicalUrl: "https://example.com/a", pageType: "CONTENT", visibleTextHash: "hash-a", normalizedVisibleText: "one two three four five" }),
    makePage({ url: "https://example.com/tag/a", finalUrl: "https://example.com/tag/a", canonicalUrl: "https://example.com/tag/a", pageType: "TAG_ARCHIVE", visibleTextHash: "hash-b", normalizedVisibleText: "one two three four six" })
  ], "https://example.com/");
  assert.equal(rows[0].duplicate_type, "");
  assert.equal(rows[1].duplicate_type, "");
});

test("url variants require high similarity or an obvious campaign marker", () => {
  const rows = buildAuditRows([
    makePage({ url: "https://example.com/holafly", finalUrl: "https://example.com/holafly", canonicalUrl: "https://example.com/holafly", visibleTextHash: "hash-a", normalizedVisibleText: "alpha beta gamma delta epsilon zeta eta theta" }),
    makePage({ url: "https://example.com/holafly-2026-campaign", finalUrl: "https://example.com/holafly-2026-campaign", canonicalUrl: "https://example.com/holafly-2026-campaign", visibleTextHash: "hash-b", normalizedVisibleText: "alpha beta gamma" })
  ], "https://example.com/");
  assert.equal(rows[0].duplicate_type, "URL_VARIANT");
  assert.equal(rows[1].duplicate_type, "URL_VARIANT");
});

test("duplicate title is detected", () => {
  const rows = buildAuditRows([
    makePage({ url: "https://example.com/a", finalUrl: "https://example.com/a", canonicalUrl: "https://example.com/a", title: "Same", visibleTextHash: "hash-a" }),
    makePage({ url: "https://example.com/b", finalUrl: "https://example.com/b", canonicalUrl: "https://example.com/b", title: "Same", visibleTextHash: "hash-b", normalizedVisibleText: "different words" })
  ], "https://example.com/");
  assert.match(rows[0].content_risk, /Duplicate title used by 2 pages/);
});

test("content pages under 100 words are prioritized", () => {
  const rows = buildAuditRows([
    makePage({
      visibleWordCount: 80,
      normalizedVisibleText: "short words here",
      visibleTextHash: "hash-short"
    })
  ], "https://example.com/");
  assert.equal(rows[0].priority, 25);
  assert.match(rows[0].content_risk, /Only 80 visible words/);
});

test("utility pages under 100 words are not prioritized", () => {
  const rows = buildAuditRows([
    makePage({
      url: "https://example.com/contact",
      finalUrl: "https://example.com/contact",
      canonicalUrl: "https://example.com/contact",
      pageType: "UTILITY",
      visibleWordCount: 80,
      normalizedVisibleText: "contact page short",
      visibleTextHash: "hash-contact"
    })
  ], "https://example.com/");
  assert.equal(rows[0].priority, 0);
  assert.equal(rows[0].content_risk, "");
});

test("recommendations are based on the highest-impact issue", () => {
  const rows = buildAuditRows([
    makePage({
      url: "https://example.com/fail",
      finalUrl: "https://example.com/fail",
      status: 404,
      title: "",
      h1Count: 0,
      firstH1: "",
      visibleWordCount: 40,
      normalizedVisibleText: "short failed page",
      visibleTextHash: "hash-fail"
    })
  ], "https://example.com/");
  assert.match(rows[0].recommended_action, /Redirect it or restore the page/);
});

test("top priority console output excludes archive pages without severe issues", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };

  try {
    printSummary([
      makePage({ url: "https://example.com/tag/japan", finalUrl: "https://example.com/tag/japan", canonicalUrl: "https://example.com/tag/japan", pageType: "TAG_ARCHIVE" }),
      makePage({ url: "https://example.com/article", finalUrl: "https://example.com/article", canonicalUrl: "https://example.com/article", pageType: "CONTENT" })
    ], [
      {
        priority: 10,
        url: "https://example.com/tag/japan",
        page_type: "TAG_ARCHIVE",
        status: "200",
        indexable: "yes",
        title: "Japan",
        h1: "Japan",
        word_count: 500,
        technical_issues: "",
        content_risk: "Near-duplicate content",
        recommended_action: "Review archive overlap.",
        response_time_ms: 10,
        canonical: "https://example.com/tag/japan",
        internal_links: 1,
        external_links: 0,
        images_missing_alt: 0,
        duplicate_type: "NEAR_DUPLICATE",
        duplicate_urls: "https://example.com/tag/asia",
        similarity: "91",
        severe_canonical_issue: "no"
      },
      {
        priority: 25,
        url: "https://example.com/article",
        page_type: "CONTENT",
        status: "200",
        indexable: "yes",
        title: "Article",
        h1: "Article",
        word_count: 80,
        technical_issues: "",
        content_risk: "Only 80 visible words",
        recommended_action: "Expand or consolidate.",
        response_time_ms: 10,
        canonical: "https://example.com/article",
        internal_links: 1,
        external_links: 0,
        images_missing_alt: 0,
        duplicate_type: "",
        duplicate_urls: "",
        similarity: "",
        severe_canonical_issue: "no"
      }
    ], "output/site-audit.csv");
  } finally {
    console.log = originalLog;
  }

  const topLines = logs.filter((line) => line.startsWith("- ["));
  assert.equal(topLines.length, 1);
  assert.match(topLines[0], /https:\/\/example\.com\/article/);
});
