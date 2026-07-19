import test from "node:test";
import assert from "node:assert/strict";
import { parseRedirectsYaml } from "../src/compare.js";
import { parseClaudeJson, parseClaudeResponse, selectTriageCandidates, shouldReuseCache, sortTriageRows } from "../src/triage.js";

test("page selection prefers larger traffic loss", () => {
  const rows = selectTriageCandidates({
    recoveryRows: [
      {
        url: "https://example.com/a/",
        finalUrl: "https://example.com/a/",
        beforeClicks: 10,
        afterClicks: 0,
        clickLoss: 10,
        beforeImpressions: 1000,
        afterImpressions: 100,
        impressionLoss: 900,
        technicalIssue: "",
        recoveryBucket: "INDEXABLE_BUT_VISIBILITY_COLLAPSED"
      },
      {
        url: "https://example.com/b/",
        finalUrl: "https://example.com/b/",
        beforeClicks: 10,
        afterClicks: 0,
        clickLoss: 10,
        beforeImpressions: 100,
        afterImpressions: 90,
        impressionLoss: 10,
        technicalIssue: "",
        recoveryBucket: "INDEXABLE_BUT_VISIBILITY_COLLAPSED"
      }
    ],
    compareRows: [],
    crawlRows: new Map([
      ["https://example.com/a/", { url: "https://example.com/a/", pageType: "CONTENT", status: "200", indexable: "yes", title: "Holafly A", technicalIssues: "" }],
      ["https://example.com/b/", { url: "https://example.com/b/", pageType: "CONTENT", status: "200", indexable: "yes", title: "Holafly B", technicalIssues: "" }]
    ]),
    limit: 2
  });
  assert.equal(rows[0].url, "https://example.com/a/");
});

test("redirect alias grouping uses the final current URL", () => {
  const rules = parseRedirectsYaml(`301:\n  ^\\/blog\\/(?!rss\\/$)([a-z0-9-]+)\\/$: /$1/`);
  assert.equal(rules.regex.length, 1);
});

test("cache reuse depends on matching content hash and model", () => {
  assert.equal(shouldReuseCache({ model: "x", url: "u", contentHash: "abc", result: {} as never, analyzedAt: "now" }, "x", "abc"), true);
  assert.equal(shouldReuseCache({ model: "x", url: "u", contentHash: "abc", result: {} as never, analyzedAt: "now" }, "y", "abc"), false);
});

test("valid structured JSON parsing succeeds", () => {
  const parsed = parseClaudeJson(`{"page_purpose":"Guide","primary_search_intent":"Find tickets","content_cluster":"TEAMLAB","distinctiveness_score":60,"firsthand_evidence_score":70,"specificity_score":65,"commercial_pressure_score":20,"templated_language_score":10,"overlap_risk_score":30,"trust_evidence_score":55,"likely_user_value_score":62,"strengths":["specific"],"weaknesses":["dated"],"evidence_missing":["pricing proof"],"overlapping_topics":["teamlab"],"recommended_disposition":"IMPROVE","recommended_action":"Update firsthand details.","confidence":"MEDIUM"}`);
  assert.equal(parsed.content_cluster, "TEAMLAB");
  assert.equal(parsed.recommended_disposition, "IMPROVE");
});

test("missing text response throws a clear error", () => {
  assert.throws(
    () => parseClaudeResponse("claude-sonnet-5", {
      stop_reason: "end_turn",
      content: [{ type: "tool_use" }]
    }),
    /missing text.*claude-sonnet-5.*content block types: tool_use/i
  );
});

test("max_tokens response throws a clear error", () => {
  assert.throws(
    () => parseClaudeResponse("claude-sonnet-5", {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "{\"page_purpose\":\"Guide\"}" }]
    }),
    /max_tokens.*claude-sonnet-5.*returned text/i
  );
});

test("final priority sorting is descending", () => {
  const rows = sortTriageRows([
    {
      priority: 10,
      url: "https://example.com/b/",
      final_url: "https://example.com/b/",
      content_cluster: "OTHER",
      before_clicks: 1,
      after_clicks: 0,
      click_loss: 1,
      before_impressions: 10,
      after_impressions: 0,
      impression_loss: 10,
      page_purpose: "",
      primary_search_intent: "",
      distinctiveness_score: 0,
      firsthand_evidence_score: 0,
      specificity_score: 0,
      commercial_pressure_score: 0,
      templated_language_score: 0,
      overlap_risk_score: 0,
      trust_evidence_score: 0,
      likely_user_value_score: 0,
      overlap_with_urls: "",
      overlap_summary: "",
      strengths: "",
      weaknesses: "",
      evidence_missing: "",
      recommended_disposition: "IMPROVE",
      recommended_action: "",
      confidence: "LOW",
      technical_issue: "",
      content_hash: "1",
      analyzed_at: "now"
    },
    {
      priority: 20,
      url: "https://example.com/a/",
      final_url: "https://example.com/a/",
      content_cluster: "OTHER",
      before_clicks: 1,
      after_clicks: 0,
      click_loss: 1,
      before_impressions: 20,
      after_impressions: 0,
      impression_loss: 20,
      page_purpose: "",
      primary_search_intent: "",
      distinctiveness_score: 0,
      firsthand_evidence_score: 0,
      specificity_score: 0,
      commercial_pressure_score: 0,
      templated_language_score: 0,
      overlap_risk_score: 0,
      trust_evidence_score: 0,
      likely_user_value_score: 0,
      overlap_with_urls: "",
      overlap_summary: "",
      strengths: "",
      weaknesses: "",
      evidence_missing: "",
      recommended_disposition: "IMPROVE",
      recommended_action: "",
      confidence: "LOW",
      technical_issue: "",
      content_hash: "2",
      analyzed_at: "now"
    }
  ]);
  assert.equal(rows[0].url, "https://example.com/a/");
});
