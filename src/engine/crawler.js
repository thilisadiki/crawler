import EventEmitter from 'events';
import { URL } from 'url';
import * as cheerio from 'cheerio';
import { BrowserManager } from './browser.js';
import { Extractor } from './extractor.js';
import { RobotsParser } from './robots.js';
import { LinkStatusChecker } from './statusChecker.js';
import { GEO_PRESETS, detectRegionFromUrl } from './geoPresets.js';

export class SiteCrawler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.seedUrl = options.seedUrl || '';
    this.crawlScope = options.crawlScope || 'domain'; // 'single-url' | 'subpath' | 'domain' | 'subdomains'
    this.maxDepth = options.crawlScope === 'single-url' ? 0 : (options.maxDepth !== undefined ? parseInt(options.maxDepth, 10) : 3);
    this.maxPages = options.crawlScope === 'single-url' ? 1 : (options.maxPages !== undefined ? parseInt(options.maxPages, 10) : 50);
    this.concurrency = options.concurrency !== undefined ? parseInt(options.concurrency, 10) : 2;
    this.pageTimeoutMs = options.pageTimeoutMs || 30000;
    this.delayBetweenRequestsMs = options.delayBetweenRequestsMs || 500;
    this.autoScroll = options.autoScroll !== false;
    this.waitForSelector = options.waitForSelector || '';
    
    // Regional Geo & Proxy configuration
    this.region = options.region || 'auto';
    this.proxy = options.proxy || null;
    this.blockCrossDomainRedirects = options.blockCrossDomainRedirects !== false;

    // Custom content / SEO container selector
    this.customContentSelector = options.customContentSelector || options.kenticoSelector || '';
    this.customContentLabel = options.customContentLabel || 'Content Area';

    // Exclusion & Inclusion rules
    this.excludePatterns = this.compileRegexList(options.excludePatterns || []);
    this.includePatterns = this.compileRegexList(options.includePatterns || []);

    // Robots.txt
    this.respectRobotsTxt = options.respectRobotsTxt === true;
    this.robotsParser = null;
    this.isBrowserMode = true;

    try {
      const parsedSeed = new URL(this.seedUrl);
      this.baseOrigin = parsedSeed.origin;
      this.baseHostname = parsedSeed.hostname;
      this.basePathname = parsedSeed.pathname.endsWith('/') ? parsedSeed.pathname : parsedSeed.pathname.replace(/\/[^/]*$/, '/') || '/';
      this.rootDomain = this.getRootDomain(parsedSeed.hostname);
    } catch (e) {
      this.baseOrigin = '';
      this.baseHostname = '';
      this.basePathname = '/';
      this.rootDomain = '';
    }

    // Resolve Geo Settings
    if (this.region && this.region !== 'auto' && GEO_PRESETS[this.region]) {
      this.geo = GEO_PRESETS[this.region];
    } else {
      this.geo = detectRegionFromUrl(this.seedUrl);
    }

    // Initialize Browser Manager
    this.browserManager = new BrowserManager({
      headless: true,
      proxy: this.proxy,
      geo: this.geo,
      blockCrossDomainRedirects: this.blockCrossDomainRedirects,
      targetHostname: this.baseHostname
    });

    this.statusChecker = new LinkStatusChecker({
      geo: this.geo
    });

    // Crawl State
    this.isRunning = false;
    this.isPaused = false;
    this.isCancelled = false;
    this.queue = [];
    this.visited = new Set();
    this.queued = new Set();
    this.results = [];

    // Crawl Statistics
    this.stats = {
      pagesCrawled: 0,
      pagesQueued: 0,
      internalLinksCount: 0,
      externalLinksCount: 0,
      errorsCount: 0,
      customDetectedCount: 0,
      blockedByRobotsCount: 0,
      excludedByRulesCount: 0,
      startTime: null,
      endTime: null
    };
  }

  compileRegexList(patterns) {
    if (!Array.isArray(patterns)) {
      patterns = typeof patterns === 'string' ? patterns.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
    }
    return patterns.map(p => {
      if (p instanceof RegExp) return p;
      try {
        return new RegExp(p);
      } catch (e) {
        // Fallback to literal substring
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(escaped);
      }
    });
  }

  getRootDomain(hostname) {
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    // Handle domains like .co.za, .co.uk, .com.au
    const secondLevelTlds = ['co.za', 'co.uk', 'com.au', 'com.br', 'co.nz'];
    const joinedEnd = parts.slice(-2).join('.');
    if (secondLevelTlds.includes(joinedEnd) && parts.length > 2) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isCancelled = false;
    this.isPaused = false;
    this.stats.startTime = Date.now();

    const normalizedSeed = Extractor.normalizeUrl(this.seedUrl, this.seedUrl);
    if (!normalizedSeed) {
      this.emit('error', { message: 'Invalid Seed URL' });
      this.isRunning = false;
      return;
    }

    // Initialize robots.txt if respectRobotsTxt is enabled
    if (this.respectRobotsTxt) {
      try {
        this.emit('statusUpdate', { message: 'Fetching and evaluating robots.txt...' });
        this.robotsParser = await RobotsParser.fetchForOrigin(normalizedSeed, 'Mozilla/5.0');
      } catch (err) {
        console.warn('Could not fetch robots.txt:', err);
      }
    }

    this.queue.push({ url: normalizedSeed, depth: 0, sourceUrl: 'SEED' });
    this.queued.add(normalizedSeed);
    this.stats.pagesQueued = this.queue.length;

    this.emit('started', { seedUrl: normalizedSeed, config: this.getConfigSummary() });

    try {
      await this.browserManager.init();
      this.isBrowserMode = true;
    } catch (err) {
      console.warn('Chromium initialization unavailable (' + err.message + '). Switching seamlessly to Ultra-Fast Direct DOM Engine!');
      this.isBrowserMode = false;
    }

    try {
      await this.runWorkerPool();
    } catch (err) {
      console.error('Crawler execution error:', err);
      this.lastError = err.message;
      this.stats.errorsCount++;
      this.emit('error', { message: err.message });
    } finally {
      this.stats.endTime = Date.now();
      this.isRunning = false;
      if (this.isBrowserMode) {
        await this.browserManager.close().catch(() => {});
      }
      this.emit('completed', { stats: this.stats, resultsCount: this.results.length });
    }
  }

  async runWorkerPool() {
    const workers = [];
    for (let i = 0; i < this.concurrency; i++) {
      workers.push(this.worker(i));
    }
    await Promise.all(workers);
  }

  async worker(workerId) {
    while (this.queue.length > 0 && !this.isCancelled) {
      while (this.isPaused && !this.isCancelled) {
        await new Promise(r => setTimeout(r, 500));
      }

      if (this.stats.pagesCrawled >= this.maxPages || this.isCancelled) {
        break;
      }

      const item = this.queue.shift();
      if (!item) break;

      if (this.visited.has(item.url)) {
        continue;
      }
      this.visited.add(item.url);

      if (this.isBrowserMode) {
        await this.processPage(item, workerId);
      } else {
        await this.processPageHttp(item, workerId);
      }

      if (this.delayBetweenRequestsMs > 0 && this.queue.length > 0) {
        await new Promise(r => setTimeout(r, this.delayBetweenRequestsMs));
      }
    }
  }

  async processPageHttp(item, workerId) {
    const { url, depth, sourceUrl } = item;
    const pageStartTime = Date.now();

    let crawlResult = {
      id: this.stats.pagesCrawled + 1,
      url,
      depth,
      sourceUrl,
      statusCode: 200,
      statusText: 'OK',
      responseTimeMs: 0,
      title: '',
      metaDescription: '',
      canonical: '',
      metaRobots: '',
      h1: '',
      h1List: [],
      h2List: [],
      imagesCount: 0,
      customContent: { detected: false, wordCount: 0, textSnippet: '', headings: [], selectorUsed: '' },
      totalWords: 0,
      internalLinksCount: 0,
      externalLinksCount: 0,
      customLinksCount: 0,
      links: [],
      error: null,
      timestamp: new Date().toISOString()
    };

    try {
      const geo = this.geo || {};
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': `${geo.locale || 'en-US'},en;q=0.9`,
        'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"'
      };
      if (geo.ip) {
        headers['X-Forwarded-For'] = geo.ip;
        headers['Client-IP'] = geo.ip;
      }

      const response = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.pageTimeoutMs)
      });

      crawlResult.statusCode = response.status;
      crawlResult.statusText = response.statusText;
      crawlResult.responseTimeMs = Date.now() - pageStartTime;

      const html = await response.text();
      const extracted = Extractor.extractFromHtml(html, response.url || url, this.baseOrigin, {
        customSelector: this.customContentSelector,
        cheerio
      });

      Object.assign(crawlResult, extracted);
      crawlResult.h1 = (extracted.h1List && extracted.h1List[0]) || '';
      crawlResult.url = response.url || url;

      // Verify HTTP status codes in parallel
      if (extracted.links && extracted.links.length > 0) {
        await this.statusChecker.checkLinksInParallel(extracted.links, 12);
      }

      // Classify and check discovered links
      const internalLinks = [];
      const externalLinks = [];
      let customLinks = 0;

      for (const link of crawlResult.links) {
        if (link.isInsideCustom) customLinks++;
        if (link.isInternal) {
          internalLinks.push(link);
          this.stats.internalLinksCount++;
        } else {
          externalLinks.push(link);
          this.stats.externalLinksCount++;
        }
      }

      crawlResult.internalLinksCount = internalLinks.length;
      crawlResult.externalLinksCount = externalLinks.length;
      crawlResult.customLinksCount = customLinks;
      if (crawlResult.customContent?.detected) {
        this.stats.customDetectedCount++;
      }

      // Add internal links to queue if depth permits
      if (depth < this.maxDepth && this.crawlScope !== 'single-url') {
        for (const link of internalLinks) {
          if (!link.isNofollow && link.isValidHttp) {
            this.addToQueue(link.url, depth + 1, crawlResult.url);
          }
        }
      }
    } catch (err) {
      crawlResult.error = err.message;
      this.stats.errorsCount++;
    }

    this.results.push(crawlResult);
    this.stats.pagesCrawled++;
    this.stats.pagesQueued = this.queue.length;

    this.emit('pageCrawled', {
      result: crawlResult,
      stats: { ...this.stats },
      queueLength: this.queue.length
    });
  }

  async processPage(item, workerId) {
    const { url, depth, sourceUrl } = item;
    const pageStartTime = Date.now();
    let pageContext = null;
    let page = null;

    let crawlResult = {
      id: this.stats.pagesCrawled + 1,
      url,
      depth,
      sourceUrl,
      statusCode: null,
      statusText: '',
      responseTimeMs: 0,
      title: '',
      metaDescription: '',
      canonical: '',
      metaRobots: '',
      h1: '',
      h1List: [],
      h2List: [],
      imagesCount: 0,
      customContent: { detected: false, wordCount: 0, textSnippet: '', headings: [], selectorUsed: '' },
      totalWords: 0,
      internalLinksCount: 0,
      externalLinksCount: 0,
      customLinksCount: 0,
      links: [],
      error: null,
      timestamp: new Date().toISOString()
    };

    try {
      pageContext = await this.browserManager.createPageContext();
      page = pageContext.page;
      page.setDefaultTimeout(this.pageTimeoutMs);

      let mainResponse = null;
      try {
        mainResponse = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: this.pageTimeoutMs
        });
      } catch (navErr) {
        mainResponse = await page.goto(url, { waitUntil: 'load', timeout: this.pageTimeoutMs }).catch(() => null);
      }

      if (mainResponse) {
        crawlResult.statusCode = mainResponse.status();
        crawlResult.statusText = mainResponse.statusText();
      } else {
        crawlResult.statusCode = 200;
      }

      if (this.waitForSelector) {
        try {
          await page.waitForSelector(this.waitForSelector, { timeout: 4000 });
        } catch (e) {}
      }

      // Allow dynamic client hydration
      await page.waitForTimeout(800);

      // Auto-scroll for lazy loaded widgets
      if (this.autoScroll) {
        await this.browserManager.autoScroll(page, 2000);
      }

      // Extract all page metadata, links, and custom content
      const extracted = await Extractor.extractPageData(page, url, this.baseOrigin, {
        customSelector: this.customContentSelector
      });

      // Verify HTTP status code for every internal and external link in parallel
      if (extracted.links && extracted.links.length > 0) {
        await this.statusChecker.checkLinksInParallel(extracted.links, 12);
      }

      crawlResult.title = extracted.title;
      crawlResult.metaDescription = extracted.metaDescription;
      crawlResult.canonical = extracted.canonical;
      crawlResult.metaRobots = extracted.metaRobots;
      crawlResult.h1List = extracted.h1List;
      crawlResult.h1 = extracted.h1List[0] || '';
      crawlResult.h2List = extracted.h2List;
      crawlResult.totalWords = extracted.totalWords;
      crawlResult.imagesCount = extracted.imagesCount;
      crawlResult.fullPageText = extracted.fullPageText;
      crawlResult.customContent = extracted.customContent;
      crawlResult.links = extracted.links;

      if (extracted.customContent && extracted.customContent.detected) {
        this.stats.customDetectedCount++;
      }

      let internalCount = 0;
      let externalCount = 0;
      let customLinksCount = 0;

      for (const link of extracted.links) {
        if (link.isInsideCustom) customLinksCount++;

        const linkRecord = {
          sourceUrl: url,
          targetUrl: link.url,
          rawHref: link.rawHref,
          anchorText: link.anchorText,
          linkType: link.linkType,
          statusCode: link.statusCode || 200,
          isInsideCustom: link.isInsideCustom,
          isNofollow: link.isNofollow,
          pageDepth: depth
        };
        this.allLinks.push(linkRecord);

        if (link.linkType === 'Internal') {
          internalCount++;
          this.stats.internalLinksCount++;

          // Evaluate queueing only if not in single-url mode and within depth limit
          if (this.crawlScope !== 'single-url' && depth < this.maxDepth && link.isValidHttp) {
            const normalized = Extractor.normalizeUrl(link.url, this.baseOrigin);
            if (normalized && this.isUrlAllowedInScope(normalized)) {
              if (!this.visited.has(normalized) && !this.queued.has(normalized)) {
                this.queued.add(normalized);
                this.queue.push({
                  url: normalized,
                  depth: depth + 1,
                  sourceUrl: url
                });
              }
            }
          }
        } else if (link.linkType === 'External') {
          externalCount++;
          this.stats.externalLinksCount++;
        }
      }

      crawlResult.internalLinksCount = internalCount;
      crawlResult.externalLinksCount = externalCount;
      crawlResult.customLinksCount = customLinksCount;
      crawlResult.responseTimeMs = Date.now() - pageStartTime;

    } catch (err) {
      crawlResult.error = err.message;
      crawlResult.responseTimeMs = Date.now() - pageStartTime;
      crawlResult.statusCode = crawlResult.statusCode || 500;
      this.stats.errorsCount++;
    } finally {
      if (pageContext) {
        await pageContext.context.close().catch(() => {});
      }
    }

    this.stats.pagesCrawled++;
    this.stats.pagesQueued = this.queue.length;
    this.results.push(crawlResult);

    this.emit('pageCrawled', {
      result: crawlResult,
      stats: { ...this.stats },
      queueLength: this.queue.length
    });
  }

  /**
   * Check if a URL meets Scope, Exclusion, Inclusion, and Robots.txt conditions
   */
  isUrlAllowedInScope(urlStr) {
    try {
      const urlObj = new URL(urlStr);

      // 1. Robots.txt check
      if (this.respectRobotsTxt && this.robotsParser) {
        if (!this.robotsParser.isAllowed(urlStr)) {
          this.stats.blockedByRobotsCount++;
          return false;
        }
      }

      // 2. Scope check
      if (this.crawlScope === 'single-url') {
        return false;
      } else if (this.crawlScope === 'subpath') {
        if (urlObj.hostname !== this.baseHostname || !urlObj.pathname.startsWith(this.basePathname)) {
          return false;
        }
      } else if (this.crawlScope === 'domain') {
        if (urlObj.hostname !== this.baseHostname) {
          return false;
        }
      } else if (this.crawlScope === 'subdomains') {
        if (!urlObj.hostname.endsWith(this.rootDomain)) {
          return false;
        }
      }

      // 3. Exclusion rules
      const pathAndSearch = urlObj.pathname + urlObj.search;
      for (const regex of this.excludePatterns) {
        if (regex.test(pathAndSearch) || regex.test(urlStr)) {
          this.stats.excludedByRulesCount++;
          return false;
        }
      }

      // 4. Inclusion rules (if any configured)
      if (this.includePatterns.length > 0) {
        const matchesAny = this.includePatterns.some(regex => regex.test(pathAndSearch) || regex.test(urlStr));
        if (!matchesAny) {
          this.stats.excludedByRulesCount++;
          return false;
        }
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  pause() {
    this.isPaused = true;
    this.emit('paused');
  }

  resume() {
    this.isPaused = false;
    this.emit('resumed');
  }

  stop() {
    this.isCancelled = true;
    this.queue = [];
    this.emit('stopped');
  }

  getConfigSummary() {
    return {
      seedUrl: this.seedUrl,
      crawlScope: this.crawlScope,
      maxDepth: this.maxDepth,
      maxPages: this.maxPages,
      concurrency: this.concurrency,
      respectRobotsTxt: this.respectRobotsTxt,
      customContentSelector: this.customContentSelector,
      excludePatternsCount: this.excludePatterns.length,
      includePatternsCount: this.includePatterns.length,
      autoScroll: this.autoScroll
    };
  }
}
