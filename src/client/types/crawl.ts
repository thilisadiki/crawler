export type CrawlScope = 'domain' | 'subpath' | 'single-url' | 'subdomains';
export type CrawlState = 'ready' | 'running' | 'paused' | 'stopping' | 'completed';

export interface CrawlConfig {
  seedUrl: string;
  crawlScope: CrawlScope;
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  delayBetweenRequestsMs: number;
  autoScroll: boolean;
}

export interface CrawlStats {
  pagesCrawled: number;
  pagesQueued?: number;
  internalLinksCount?: number;
  externalLinksCount?: number;
  errorsCount?: number;
  blockedByRobotsCount?: number;
  customDetectedCount?: number;
}

export interface CrawlCapacity {
  activeCrawls: number;
  maxConcurrentCrawls: number;
  availableSlots: number;
  maxWorkersPerCrawl: number;
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

export interface CrawlPage {
  url: string;
  statusCode?: number | null;
  title?: string;
  metaDescription?: string;
  canonical?: string;
  metaRobots?: string;
  h1?: string;
  h1List?: string[];
  h2List?: string[];
  responseTime?: number | null;
  responseTimeMs?: number | null;
  wordCount?: number;
  totalWords?: number;
  internalLinksCount?: number;
  externalLinksCount?: number;
  customLinksCount?: number;
  fullPageText?: string;
  error?: string;
  links?: CrawledLink[];
  resources?: CrawledResource[];
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
