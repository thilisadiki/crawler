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
  url: string;
  anchorText?: string;
  linkType?: string;
  statusCode?: number | null;
  isNofollow?: boolean;
  isInsideCustom?: boolean;
}

export interface CustomContent {
  detected?: boolean;
  selectorUsed?: string;
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
  h1?: string;
  h1List?: string[];
  h2List?: string[];
  responseTime?: number | null;
  wordCount?: number;
  fullPageText?: string;
  error?: string;
  links?: CrawledLink[];
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
