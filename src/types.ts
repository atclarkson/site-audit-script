export type AuditOptions = {
  limit: number;
  outputPath: string;
  concurrency: number;
  timeoutMs: number;
  maxBodyBytes: number;
  userAgent: string;
};

export type FetchResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  responseTimeMs: number;
  body: string;
  error?: string;
};

export type PageType =
  | "CONTENT"
  | "HOMEPAGE"
  | "TAG_ARCHIVE"
  | "AUTHOR_ARCHIVE"
  | "LEGAL"
  | "UTILITY"
  | "OTHER";

export type PageMetrics = {
  url: string;
  finalUrl: string;
  status: number;
  responseTimeMs: number;
  contentType: string;
  title: string;
  metaDescription: string;
  canonicalUrl: string;
  metaRobots: string;
  indexable: boolean;
  h1Count: number;
  firstH1: string;
  visibleWordCount: number;
  normalizedVisibleText: string;
  visibleTextHash: string;
  internalLinkCount: number;
  externalLinkCount: number;
  imageCount: number;
  imagesMissingAltCount: number;
  pageType: PageType;
  fetchError?: string;
};

export type AuditRow = {
  priority: number;
  url: string;
  page_type: PageType;
  status: string;
  indexable: string;
  title: string;
  h1: string;
  word_count: number;
  technical_issues: string;
  content_risk: string;
  recommended_action: string;
  response_time_ms: number;
  canonical: string;
  internal_links: number;
  external_links: number;
  images_missing_alt: number;
  duplicate_type: string;
  duplicate_urls: string;
  similarity: string;
  severe_canonical_issue: string;
};
