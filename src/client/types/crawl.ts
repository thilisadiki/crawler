export type CrawlScope = 'domain' | 'subpath' | 'single-url' | 'subdomains';
export type CrawlState = 'ready' | 'running' | 'paused' | 'stopping' | 'completed';

export interface CrawlConfig {
  seedUrl: string;
  crawlScope: CrawlScope;
  maxPages: number;
  noPageLimit: boolean;
  maxDepth: number;
  concurrency: number;
  delayBetweenRequestsMs: number;
  autoScroll: boolean;
  customContentSelector: string;
  excludePatterns: string[];
  includePatterns: string[];
  respectRobotsTxt: boolean;
  region: string;
  blockCrossDomainRedirects: boolean;
}

export interface CrawlStats {
  pagesCrawled: number;
  pagesQueued?: number;
  internalLinksCount?: number;
  externalLinksCount?: number;
  errorsCount?: number;
  blockedByRobotsCount?: number;
  customDetectedCount?: number;
  startTime?: number;
  endTime?: number | null;
  pausedDurationMs?: number;
  pausedAt?: number | null;
}

export interface CrawlCapacity {
  activeCrawls: number;
  maxConcurrentCrawls: number;
  availableSlots: number;
  maxWorkersPerCrawl: number;
  maxUnlimitedCrawlPages?: number;
}

export interface EngineStatus {
  mode?: 'browser' | 'http' | 'recovering' | 'initializing';
  provider?: string | null;
  error?: string | null;
}

export interface CrawledLink {
  url?: string;
  targetUrl?: string;
  rawHref?: string;
  anchorText?: string;
  linkType?: string;
  isInternal?: boolean;
  rel?: string;
  target?: string;
  sourceUrl?: string;
  statusCode?: number | null;
  finalStatusCode?: number | null;
  finalUrl?: string;
  redirectCount?: number;
  redirectError?: string | null;
  redirectChain?: Array<{ url: string; statusCode: number; destinationUrl: string }>;
  isNofollow?: boolean;
  isInsideCustom?: boolean;
}

export interface CrawledResource {
  url: string;
  rawUrl?: string;
  resourceType?: string;
  element?: string;
  attribute?: string;
  statusCode?: number | null;
  sizeBytes?: number | null;
  discoveryStatus?: string;
  sourceUrl?: string;
}

export interface CustomContent {
  detected?: boolean;
  selectorUsed?: string;
  detectionMethod?: string;
  headings?: string[];
  textSnippet?: string;
  fullText?: string;
  wordCount?: number;
}

export interface RenderComparison {
  available?: boolean;
  reason?: string;
  sourceHtmlBytes?: number;
  renderedHtmlBytes?: number;
  sourceWordCount?: number;
  renderedWordCount?: number;
  renderedOnlyWordCount?: number;
  sourceScriptCount?: number;
  renderedScriptCount?: number;
  sourceElementCount?: number;
  renderedElementCount?: number;
  domChanged?: boolean;
}

export interface HtmlComparisonCapture {
  capturedAt: string;
  source: { html: string; totalBytes: number; truncated: boolean; url: string };
  rendered: { html: string; totalBytes: number; truncated: boolean; url: string; error?: string | null };
  comparison: RenderComparison;
}

export interface CrawledImage {
  elementIndex: number;
  url: string;
  rawSrc: string;
  currentSrc: string;
  srcset: string;
  lazySrc: string;
  alt: string | null;
  widthAttribute: string | null;
  heightAttribute: string | null;
  declaredWidth: number | null;
  declaredHeight: number | null;
  naturalWidth: number | null;
  naturalHeight: number | null;
  renderedWidth: number | null;
  renderedHeight: number | null;
  loading: string;
  statusCode: number | null;
  sizeBytes: number | null;
  discoveryStatus: string;
}

export interface CrawlPage {
  id?: number;
  url: string;
  statusCode?: number | null;
  title?: string;
  metaDescription?: string;
  metaKeywords?: string;
  canonical?: string;
  metaRobots?: string;
  h1?: string;
  h1List?: string[];
  h2List?: string[];
  responseTime?: number | null;
  responseTimeMs?: number | null;
  wordCount?: number;
  totalWords?: number;
  imagesCount?: number | null;
  images?: CrawledImage[] | null;
  internalLinksCount?: number;
  externalLinksCount?: number;
  customLinksCount?: number;
  fullPageText?: string;
  hasStoredContent?: boolean;
  error?: string;
  links?: CrawledLink[];
  resources?: CrawledResource[];
  renderComparison?: RenderComparison | null;
  customContent?: CustomContent;
}

export interface CrawlerStatus {
  isRunning: boolean;
  isPaused?: boolean;
  isStopping?: boolean;
  stats: CrawlStats | null;
  queueLength?: number;
  engine?: EngineStatus | null;
  capacity?: CrawlCapacity;
}

export interface CrawlerSnapshot extends CrawlerStatus {
  revision: number;
  results: CrawlPage[];
  links: CrawledLink[];
  historyAudit?: HistoryAudit | null;
}

export interface HistoryAudit {
  crawlId: string;
  totalPages: number;
  loadedPages: number;
  totalResources?: number;
}

export interface CrawlHistoryRecord {
  id: string;
  seedUrl: string;
  status: string;
  stats: CrawlStats | null;
  engine: EngineStatus | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface CrawlHistoryDetail {
  crawl: CrawlHistoryRecord & { config?: Record<string, unknown> };
  results: CrawlPage[];
}

export interface CrawlHistoryPageWindow {
  crawl: CrawlHistoryRecord & { config?: Partial<CrawlConfig> };
  results: CrawlPage[];
  total: number;
  offset: number;
  limit: number;
  resourceTotal?: number;
  counts: Record<'all' | 'title' | 'description' | 'keywords' | 'h1' | 'h2' | 'content', number>;
}

export interface CrawlHistoryLinkWindow {
  links: CrawledLink[];
  total: number;
  offset: number;
  limit: number;
  counts: Record<'all' | 'internal' | 'external' | 'redirects' | 'in-content' | '200' | 'errors' | 'nofollow', number>;
}

export interface CrawlHistoryResourceWindow {
  resources: CrawledResource[];
  total: number;
  offset: number;
  limit: number;
  counts: Record<'all' | 'stylesheet' | 'script' | 'image' | 'media-font' | 'loaded' | 'blocked' | 'errors', number>;
}

export type CrawlComparisonChangeType = 'new' | 'missing' | 'changed';

export interface CrawlComparisonPage {
  statusCode?: number | null;
  title?: string | null;
  metaDescription?: string | null;
  canonical?: string | null;
  metaRobots?: string | null;
  h1?: string | null;
  totalWords?: number | null;
  internalLinksCount?: number | null;
  externalLinksCount?: number | null;
}

export interface CrawlComparisonChange {
  field: string;
  previous: string | number | null;
  current: string | number | null;
}

export interface CrawlComparisonRow {
  url: string;
  type: CrawlComparisonChangeType;
  previous?: CrawlComparisonPage;
  current?: CrawlComparisonPage;
  changes: CrawlComparisonChange[];
}

export interface CrawlComparison {
  previous: CrawlHistoryRecord;
  current: CrawlHistoryRecord;
  summary: { previousPages: number; currentPages: number; new: number; missing: number; changed: number; unchanged: number };
  rows: CrawlComparisonRow[];
}
