import test from "node:test";
import assert from "node:assert/strict";
import { applyRedirects, buildComparisonRows, normalizeSiteUrl, parseRedirectsYaml } from "../src/compare.js";

test("/blog URLs normalize to the current root path", () => {
  const rules = parseRedirectsYaml(`301:\n  ^\\/blog\\/(?!rss\\/$)([a-z0-9-]+)\\/$: /$1/`);
  assert.equal(
    applyRedirects("https://www.adamandlinds.com/blog/example-post/", rules),
    "https://adamandlinds.com/example-post/"
  );
});

test("exact redirects are applied", () => {
  const rules = parseRedirectsYaml(`301:\n  /old-page/: /new-page/`);
  assert.equal(
    applyRedirects("https://adamandlinds.com/old-page/", rules),
    "https://adamandlinds.com/new-page/"
  );
});

test("redirect chains resolve to the final destination", () => {
  const rules = parseRedirectsYaml(`301:\n  /old-page/: /middle-page/\n  /middle-page/: /final-page/`);
  assert.equal(
    applyRedirects("https://adamandlinds.com/old-page/", rules),
    "https://adamandlinds.com/final-page/"
  );
});

test("old and new URL variants aggregate into one final row", () => {
  const rules = parseRedirectsYaml(`301:\n  ^\\/blog\\/(?!rss\\/$)([a-z0-9-]+)\\/$: /$1/`);
  const rows = buildComparisonRows([
    { url: "https://www.adamandlinds.com/blog/example-post/", clicks: 10, impressions: 100, ctr: 10, position: 5 }
  ], [
    { url: "https://adamandlinds.com/example-post/", clicks: 7, impressions: 90, ctr: 7.78, position: 6 }
  ], rules);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://adamandlinds.com/example-post/");
  assert.equal(rows[0].before_clicks, 10);
  assert.equal(rows[0].after_clicks, 7);
  assert.match(rows[0].old_urls, /blog\/example-post/);
});

test("rows sort by clicks lost before impression loss", () => {
  const rules = parseRedirectsYaml("301:\n");
  const rows = buildComparisonRows([
    { url: normalizeSiteUrl("https://adamandlinds.com/a/"), clicks: 20, impressions: 100, ctr: 20, position: 5 },
    { url: normalizeSiteUrl("https://adamandlinds.com/b/"), clicks: 10, impressions: 1000, ctr: 1, position: 5 }
  ], [
    { url: normalizeSiteUrl("https://adamandlinds.com/a/"), clicks: 5, impressions: 60, ctr: 8.33, position: 6 },
    { url: normalizeSiteUrl("https://adamandlinds.com/b/"), clicks: 0, impressions: 100, ctr: 0, position: 8 }
  ], rules);
  assert.equal(rows[0].url, "https://adamandlinds.com/a/");
  assert.equal(rows[1].url, "https://adamandlinds.com/b/");
});
