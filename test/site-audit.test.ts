import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditRows, extractPageMetrics } from "../src/analyze.js";
import { normalizeUrl, parseSitemapXml } from "../src/crawl.js";
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
