import { load as loadHtml } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import type { AuditOptions, FetchResult } from "./types.js";

const XML_MIME_RE = /(xml|text\/plain)/i;

export function normalizeUrl(input: string, base?: string): string | null {
  try {
    const url = base ? new URL(input, base) : new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    url.hash = "";
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

export function isSameHostname(candidate: string, rootUrl: string): boolean {
  return new URL(candidate).hostname === new URL(rootUrl).hostname;
}

export function extractLinks(html: string, pageUrl: string, rootUrl: string): string[] {
  const $ = loadHtml(html);
  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href")?.trim();
    if (!href || /^(mailto:|tel:|javascript:|file:|data:)/i.test(href)) {
      return;
    }
    const normalized = normalizeUrl(href, pageUrl);
    if (normalized && isSameHostname(normalized, rootUrl)) {
      links.add(normalized);
    }
  });
  return [...links];
}

export function parseSitemapXml(xml: string): string[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const urls = new Set<string>();

  const collectLocs = (value: unknown): void => {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collectLocs(item);
      }
      return;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.loc === "string") {
        urls.add(record.loc.trim());
      }
      for (const nested of Object.values(record)) {
        collectLocs(nested);
      }
    }
  };

  collectLocs(parsed);
  return [...urls];
}

async function readBody(response: Response, maxBodyBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBodyBytes) {
      throw new Error(`Response exceeded ${maxBodyBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function fetchWithLimit(url: string, options: AuditOptions): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": options.userAgent,
        accept: "text/html,application/xml,text/xml;q=0.9,*/*;q=0.1",
        "accept-encoding": "gzip"
      }
    });
    const responseTimeMs = Date.now() - startedAt;
    const bodyBuffer = await readBody(response, options.maxBodyBytes);
    const body = bodyBuffer.toString("utf8");
    return {
      url,
      finalUrl: response.url || url,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      responseTimeMs,
      body
    };
  } catch (error) {
    return {
      url,
      finalUrl: url,
      status: 0,
      contentType: "",
      responseTimeMs: Date.now() - startedAt,
      body: "",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function run(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

async function discoverFromSitemaps(rootUrl: string, options: AuditOptions): Promise<string[]> {
  const sitemapCandidates = new Set<string>();
  const root = new URL(rootUrl);
  sitemapCandidates.add(new URL("/sitemap.xml", root).toString());

  const robotsUrl = new URL("/robots.txt", root).toString();
  const robots = await fetchWithLimit(robotsUrl, options);
  if (robots.status >= 200 && robots.status < 400) {
    for (const line of robots.body.split(/\r?\n/)) {
      const match = line.match(/^sitemap:\s*(.+)$/i);
      if (match) {
        const normalized = normalizeUrl(match[1].trim(), rootUrl);
        if (normalized) {
          sitemapCandidates.add(normalized);
        }
      }
    }
  }

  const queue = [...sitemapCandidates];
  const seen = new Set<string>();
  const urls = new Set<string>();

  while (queue.length > 0) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) {
      continue;
    }
    seen.add(sitemapUrl);

    const fetched = await fetchWithLimit(sitemapUrl, options);
    if (fetched.status < 200 || fetched.status >= 400 || !XML_MIME_RE.test(fetched.contentType || sitemapUrl)) {
      continue;
    }

    for (const loc of parseSitemapXml(fetched.body)) {
      const normalized = normalizeUrl(loc, rootUrl);
      if (!normalized || !isSameHostname(normalized, rootUrl)) {
        continue;
      }
      if (/\.(xml|xml\.gz)$/i.test(new URL(normalized).pathname)) {
        queue.push(normalized);
      } else {
        urls.add(normalized);
      }
    }
  }

  return [...urls];
}

async function discoverByCrawling(rootUrl: string, options: AuditOptions): Promise<string[]> {
  const queue = [normalizeUrl(rootUrl)!];
  const seen = new Set<string>(queue);

  for (let index = 0; index < queue.length && queue.length < options.limit; index += 1) {
    const current = queue[index];
    const fetched = await fetchWithLimit(current, options);
    if (fetched.error || fetched.status >= 400 || !/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) {
      continue;
    }
    for (const link of extractLinks(fetched.body, fetched.finalUrl, rootUrl)) {
      if (!seen.has(link) && seen.size < options.limit) {
        seen.add(link);
        queue.push(link);
      }
    }
  }

  return queue;
}

export async function discoverUrls(rootUrl: string, options: AuditOptions): Promise<string[]> {
  const fromSitemap = await discoverFromSitemaps(rootUrl, options);
  if (fromSitemap.length > 0) {
    return fromSitemap.sort().slice(0, options.limit);
  }
  return discoverByCrawling(rootUrl, options);
}

export async function crawlPages(
  urls: string[],
  options: AuditOptions,
  onProgress: (completed: number, total: number) => void
): Promise<FetchResult[]> {
  let completed = 0;
  return mapLimit(urls, options.concurrency, async (url) => {
    const result = await fetchWithLimit(url, options);
    completed += 1;
    onProgress(completed, urls.length);
    return result;
  });
}
