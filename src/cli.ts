import { buildAuditRows, extractPageMetrics } from "./analyze.js";
import { crawlPages, discoverUrls, normalizeUrl } from "./crawl.js";
import { writeCsv, printSummary } from "./output.js";
import type { AuditOptions } from "./types.js";

const DEFAULT_OPTIONS: AuditOptions = {
  limit: 500,
  outputPath: "output/site-audit.csv",
  concurrency: 5,
  timeoutMs: 15_000,
  maxBodyBytes: 5 * 1024 * 1024,
  userAgent: "AdamAndLindsSiteAudit/1.0"
};

function parseArgs(argv: string[]): { url: string; options: AuditOptions } {
  const args = [...argv];
  const url = args.shift();
  if (!url) {
    throw new Error("Usage: npm run audit -- <url> [--limit 100] [--output output/custom.csv]");
  }

  const options = { ...DEFAULT_OPTIONS };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      options.limit = Number(args[index + 1]);
      index += 1;
    } else if (arg === "--output") {
      options.outputPath = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    throw new Error("--limit must be a positive number");
  }

  const normalized = normalizeUrl(url);
  if (!normalized) {
    throw new Error(`Invalid URL: ${url}`);
  }

  return { url: normalized, options };
}

async function main(): Promise<void> {
  const { url, options } = parseArgs(process.argv.slice(2));
  const discovered = await discoverUrls(url, options);
  console.log(`Discovered ${discovered.length} URLs`);

  const results = await crawlPages(discovered, options, (completed, total) => {
    if (completed === total || completed % 25 === 0) {
      console.log(`Crawled ${completed}/${total}`);
    }
  });

  const metrics = results.map((result) => extractPageMetrics(result, url));
  const rows = buildAuditRows(metrics, url);
  await writeCsv(rows, options.outputPath);
  printSummary(metrics, rows, options.outputPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
