import test from "node:test";
import assert from "node:assert/strict";
import { applyRedirects, parseRedirectsYaml } from "../src/compare.js";
import { classifyRecoveryRow, sortRecoveryRows } from "../src/recover.js";

test("/blog aliases group under the current destination", () => {
  const rules = parseRedirectsYaml(`301:\n  ^\\/blog\\/(?!rss\\/$)([a-z0-9-]+)\\/$: /$1/`);
  assert.equal(
    applyRedirects("https://www.adamandlinds.com/blog/example-post/", rules),
    "https://adamandlinds.com/example-post/"
  );
});

test("redirected aliases are not treated as duplicate content", () => {
  const row = classifyRecoveryRow({
    url: "https://adamandlinds.com/example-post/",
    beforeClicks: 5,
    afterClicks: 2,
    beforeImpressions: 100,
    afterImpressions: 40,
    beforePosition: "5.00",
    afterPosition: "7.00",
    oldUrls: ["https://adamandlinds.com/blog/example-post/"],
    liveCheck: {
      requestedUrl: "https://adamandlinds.com/example-post/",
      finalUrl: "https://adamandlinds.com/example-post/",
      httpStatus: "200",
      redirectChain: "https://adamandlinds.com/example-post/",
      redirectHops: 0,
      canonical: "https://adamandlinds.com/example-post/",
      metaRobots: "",
      indexable: "yes",
      technicalIssue: ""
    },
    aliasChecks: [{
      requestedUrl: "https://adamandlinds.com/blog/example-post/",
      finalUrl: "https://adamandlinds.com/example-post/",
      httpStatus: "301",
      redirectChain: "https://adamandlinds.com/blog/example-post/",
      redirectHops: 1,
      canonical: "",
      metaRobots: "",
      indexable: "no",
      technicalIssue: ""
    }],
    inSitemap: true,
    inCrawlCsv: true
  });
  assert.doesNotMatch(row.technical_issue, /duplicate/i);
});

test("recovery bucket classification prefers technical issues", () => {
  const row = classifyRecoveryRow({
    url: "https://adamandlinds.com/example-post/",
    beforeClicks: 5,
    afterClicks: 0,
    beforeImpressions: 200,
    afterImpressions: 10,
    beforePosition: "5.00",
    afterPosition: "20.00",
    oldUrls: ["https://adamandlinds.com/blog/example-post/"],
    liveCheck: {
      requestedUrl: "https://adamandlinds.com/example-post/",
      finalUrl: "https://adamandlinds.com/example-post/",
      httpStatus: "200",
      redirectChain: "https://adamandlinds.com/example-post/",
      redirectHops: 0,
      canonical: "",
      metaRobots: "noindex",
      indexable: "no",
      technicalIssue: ""
    },
    aliasChecks: [],
    inSitemap: false,
    inCrawlCsv: false
  });
  assert.equal(row.recovery_bucket, "TECHNICAL_MIGRATION_ISSUE");
});

test("recovery rows sort by impression loss then click loss", () => {
  const rows = sortRecoveryRows([
    {
      priority: 10,
      url: "https://adamandlinds.com/b/",
      before_clicks: 10,
      after_clicks: 0,
      click_loss: 10,
      before_impressions: 100,
      after_impressions: 20,
      impression_loss: 80,
      before_position: "5",
      after_position: "8",
      position_change: "3",
      old_urls: "",
      final_url: "https://adamandlinds.com/b/",
      http_status: "200",
      redirect_chain: "",
      redirect_hops: 0,
      canonical: "",
      meta_robots: "",
      indexable: "yes",
      in_sitemap: "yes",
      recovery_bucket: "INDEXABLE_BUT_VISIBILITY_COLLAPSED",
      technical_issue: "",
      recommended_action: ""
    },
    {
      priority: 5,
      url: "https://adamandlinds.com/a/",
      before_clicks: 5,
      after_clicks: 0,
      click_loss: 5,
      before_impressions: 120,
      after_impressions: 20,
      impression_loss: 100,
      before_position: "5",
      after_position: "8",
      position_change: "3",
      old_urls: "",
      final_url: "https://adamandlinds.com/a/",
      http_status: "200",
      redirect_chain: "",
      redirect_hops: 0,
      canonical: "",
      meta_robots: "",
      indexable: "yes",
      in_sitemap: "yes",
      recovery_bucket: "INDEXABLE_BUT_VISIBILITY_COLLAPSED",
      technical_issue: "",
      recommended_action: ""
    }
  ]);
  assert.equal(rows[0].url, "https://adamandlinds.com/a/");
});
