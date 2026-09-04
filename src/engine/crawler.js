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
    this.seedUrl = Extractor.normalizeSeedUrl(options.seedUrl) || options.seedUrl || '';
    this.crawlScope = options.crawlScope || 'domain'; // 'single-url' | 'subpath' | 'domain' | 'subdomains'
    this.maxDepth = options.crawlScope === 'single-url' ? 0 : (options.maxDepth !== undefined ? parseInt(options.maxDepth, 10) : 3);
    this.maxPages = options.crawlScope === 'single-url' ? 1 : (options.maxPages !== undefined ? parseInt(options.maxPages, 10) : 50);
    this.noPageLimit = options.crawlScope !== 'single-url' && options.noPageLimit === true;
    const requestedConcurrency = options.concurrency !== undefined ? parseInt(options.concurrency, 10) : 1;
    this.concurrency = Number.isFinite(requestedConcurrency) ? Math.min(5, Math.max(1, requestedConcurrency)) : 1;
    this.pageTimeoutMs = options.pageTimeoutMs || 30000;
    this.delayBetweenRequestsMs = options.delayBetweenRequestsMs || 500;
    this.autoScroll = options.autoScroll !== false;
    this.waitForSelector = options.waitForSelector || '';
    this.linkCheckConcurrency = Math.min(12, Math.max(1, Number.parseInt(options.linkCheckConcurrency, 10) || 6));
    this.linkCheckDeadlineMs = Math.min(120000, Math.max(5000, Number.parseInt(options.linkCheckDeadlineMs, 10) || 30000));
    this.contextCloseTimeoutMs = 5000;
    
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
    this.engineMode = 'initializing';
    this.engineProvider = null;
    this.engineError = null;

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
    this.abortController = null;
    this.activePageContexts = new Set();
    this.queue = [];
    this.visited = new Set();
    this.queued = new Set();
    // Maps a requested URL to the URL reached after a redirect. It prevents a
    // later navigation link to the final destination from being audited again.
    this.redirectAliases = new Map();
    this.results = [];
    this.allLinks = [];

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
      browserRestartsCount: 0,
      browserFallbacksCount: 0,
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

  /**
   * `example.com` and `www.example.com` are commonly two entry points for the
   * same site. Keep that narrow exception separate from the broader
   * "subdomains" scope so a seed cannot silently expand to arbitrary hosts.
   */
  isWwwAlias(hostnameA, hostnameB) {
    const stripWww = hostname => String(hostname || '').toLowerCase().replace(/^www\./, '');
    return Boolean(hostnameA && hostnameB && stripWww(hostnameA) === stripWww(hostnameB));
  }

  /**
   * A homepage often redirects from http to https and/or the bare hostname to
   * www. The initial URL is only a request target; for crawling we need the
   * effective first-page origin so that its own navigation is not marked as
   * external. Never adopt an unrelated redirect.
   */
  adoptSeedRedirect(effectiveUrl, depth) {
    if (depth !== 0 || !this.baseHostname) return false;
    try {
      const effective = new URL(effectiveUrl);
      if (!this.isWwwAlias(this.baseHostname, effective.hostname)) return false;

      const previousHostname = this.baseHostname;
      const previousOrigin = this.baseOrigin;
      this.baseOrigin = effective.origin;
      this.baseHostname = effective.hostname;
      this.basePathname = effective.pathname.endsWith('/')
        ? effective.pathname
        : effective.pathname.replace(/\/[^/]*$/, '/') || '/';
      this.rootDomain = this.getRootDomain(effective.hostname);
      this.browserManager.targetHostname = effective.hostname;

      return previousHostname !== effective.hostname || previousOrigin !== effective.origin;
    } catch {
      return false;
    }
  }

  /**
   * Extraction sees the page's real URL, but links may still point back to a
   * bare/www alias. Reclassify just that alias as internal before scope and
   * queueing decisions are made.
   */
  normalizeInternalLinkAliases(links = []) {
    return links.map(link => {
      if (!link?.isValidHttp || !link.url) return link;
      try {
        const target = new URL(link.url);
        if (this.isWwwAlias(this.baseHostname, target.hostname)) {
          return { ...link, linkType: 'Internal', isInternal: true };
        }
      } catch {}
      return link;
    });
  }

  /**
   * Summarise the meaningful differences between the response source and the
   * post-JavaScript DOM without retaining two potentially huge HTML documents.
   */
  static compareSourceAndRenderedHtml(sourceHtml, renderedHtml) {
    const inspect = html => {
      const $ = cheerio.load(html || '');
      const text = $('body').text().replace(/\s+/g, ' ').trim();
      const words = text ? text.split(/\s+/).filter(Boolean) : [];
      const tokens = new Set(words.map(word => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).filter(Boolean));
      return {
        bytes: Buffer.byteLength(html || '', 'utf8'),
        wordCount: words.length,
        tokens,
        scriptCount: $('script').length,
        elementCount: $('*').length,
        normalizedText: text.toLowerCase()
      };
    };

    if (!sourceHtml || !renderedHtml) {
      return {
        available: false,
        reason: !sourceHtml ? 'The original HTML response was unavailable for comparison.' : 'The rendered DOM was unavailable for comparison.'
      };
    }

    const source = inspect(sourceHtml);
    const rendered = inspect(renderedHtml);
    const renderedOnlyWordCount = [...rendered.tokens].filter(token => !source.tokens.has(token)).length;
    return {
      available: true,
      sourceHtmlBytes: source.bytes,
      renderedHtmlBytes: rendered.bytes,
      sourceWordCount: source.wordCount,
      renderedWordCount: rendered.wordCount,
      renderedOnlyWordCount,
      sourceScriptCount: source.scriptCount,
      renderedScriptCount: rendered.scriptCount,
      sourceElementCount: source.elementCount,
      renderedElementCount: rendered.elementCount,
      domChanged: source.normalizedText !== rendered.normalizedText || source.elementCount !== rendered.elementCount
    };
  }

  registerRedirectDestination(requestedUrl, effectiveUrl) {
    const requested = Extractor.normalizeUrl(requestedUrl, this.baseOrigin);
    const effective = Extractor.normalizeUrl(effectiveUrl, effectiveUrl);
    if (!requested || !effective || requested === effective) return;
    this.redirectAliases.set(requested, effective);
    // The worker marked the requested URL as visited before fetching it. Mark
    // the effective URL too, so a homepage link such as https://www.site.com/
    // cannot produce a second audit after https://site.com/ redirected to it.
    this.visited.add(effective);
    this.queued.add(effective);
  }

  async fetchSourceSnapshot(url, signal = this.getAbortSignal(this.pageTimeoutMs)) {
    const geo = this.geo || {};
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': `${geo.locale || 'en-US'},en;q=0.9`
    };
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal
    });
    return { html: await response.text(), url: response.url || url };
  }

  static htmlPreview(html, maximumBytes = 2 * 1024 * 1024) {
    const totalBytes = Buffer.byteLength(html || '', 'utf8');
    if (totalBytes <= maximumBytes) return { html: html || '', totalBytes, truncated: false };
    return {
      html: Buffer.from(html, 'utf8').subarray(0, maximumBytes).toString('utf8'),
      totalBytes,
      truncated: true
    };
  }

  // HTML documents are intentionally captured only when a user asks to inspect
  // them. Keeping a copy for every crawled page would quickly overwhelm the
  // database and browser memory on large audits.
  async captureHtmlComparison(url) {
    const sourcePromise = this.fetchSourceSnapshot(url, AbortSignal.timeout(this.pageTimeoutMs)).catch(() => null);
    const inspectionBrowser = new BrowserManager({
      headless: true,
      proxy: this.proxy,
      geo: this.geo,
      blockCrossDomainRedirects: this.blockCrossDomainRedirects,
      targetHostname: this.baseHostname
    });
    let pageContext = null;
    let renderedHtml = '';
    let renderedUrl = url;
    let renderError = null;

    try {
      await inspectionBrowser.init();
      pageContext = await inspectionBrowser.createPageContext();
      const { page } = pageContext;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.pageTimeoutMs });
      await page.waitForFunction(() => {
        const bodyText = document.body?.innerText?.trim() || '';
        return document.querySelectorAll('a[href]').length > 0 || bodyText.length > 200;
      }, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (this.autoScroll) await inspectionBrowser.autoScroll(page, 2000);
      renderedUrl = page.url() || url;
      renderedHtml = await page.content();
    } catch (error) {
      renderError = error instanceof Error ? error.message : String(error);
    } finally {
      if (pageContext?.context) await pageContext.context.close().catch(() => {});
      await inspectionBrowser.close().catch(() => {});
    }

    const sourceSnapshot = await sourcePromise;
    const sourceHtml = sourceSnapshot?.html || '';
    return {
      capturedAt: new Date().toISOString(),
      source: { ...SiteCrawler.htmlPreview(sourceHtml), url: sourceSnapshot?.url || url },
      rendered: { ...SiteCrawler.htmlPreview(renderedHtml), url: renderedUrl, error: renderError },
      comparison: SiteCrawler.compareSourceAndRenderedHtml(sourceHtml, renderedHtml)
    };
  }

  mergeDiscoveredLinks(renderedLinks = [], sourceLinks = []) {
    const merged = new Map();
    for (const link of [...renderedLinks, ...sourceLinks]) {
      const key = `${link.url || ''}|${link.rawHref || ''}|${link.anchorText || ''}`;
      if (!merged.has(key)) merged.set(key, link);
    }
    return [...merged.values()];
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isCancelled = false;
    this.isPaused = false;
    this.abortController = new AbortController();
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
      this.engineMode = 'browser';
      this.engineProvider = this.browserManager.provider;
      this.engineError = null;
      this.emit('engineSelected', this.getEngineStatus());
    } catch (err) {
      console.warn('Chromium initialization unavailable (' + err.message + '). Switching to the Direct DOM engine.');
      this.isBrowserMode = false;
      this.engineMode = 'http';
      this.engineProvider = 'direct-dom';
      this.engineError = err.message;
      this.emit('engineSelected', this.getEngineStatus());
    }

    try {
      if (!this.isCancelled) {
        await this.runWorkerPool();
      }
    } catch (err) {
      console.error('Crawler execution error:', err);
      this.lastError = err.message;
      this.stats.errorsCount++;
      this.emit('error', { message: err.message });
    } finally {
      this.stats.endTime = Date.now();
      this.isRunning = false;
      // Always close the browser, including when a page-level error changed the engine mode.
      await this.browserManager.close().catch(() => {});
      this.emit(this.isCancelled ? 'stopped' : 'completed', {
        stats: this.stats,
        resultsCount: this.results.length,
        engine: this.getEngineStatus()
      });
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
        await this.waitForDelay(this.delayBetweenRequestsMs);
      }
    }
  }

  async processPageHttp(item, workerId, browserFailure = null) {
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
      metaKeywords: '',
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
      resources: [],
      renderMode: browserFailure ? 'direct-dom-fallback' : 'direct-dom',
      renderError: browserFailure?.message || null,
      error: null,
      timestamp: new Date().toISOString()
    };

    let httpFailed = false;
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
        signal: this.getAbortSignal(this.pageTimeoutMs)
      });

      if (this.isCancellationRequested()) return;

      crawlResult.statusCode = response.status;
      crawlResult.statusText = response.statusText;
      crawlResult.responseTimeMs = Date.now() - pageStartTime;

      const effectiveUrl = response.url || url;
      this.adoptSeedRedirect(effectiveUrl, depth);
      this.registerRedirectDestination(url, effectiveUrl);

      const html = await response.text();
      if (this.isCancellationRequested()) return;
      crawlResult.renderComparison = {
        available: false,
        reason: 'Direct DOM mode does not execute JavaScript, so no rendered DOM comparison is available.',
        sourceHtmlBytes: Buffer.byteLength(html || '', 'utf8')
      };
      const extracted = Extractor.extractFromHtml(html, effectiveUrl, this.baseOrigin, {
        customSelector: this.customContentSelector,
        cheerio
      });

      extracted.links = this.normalizeInternalLinkAliases(extracted.links);

      Object.assign(crawlResult, extracted);
      crawlResult.h1 = (extracted.h1List && extracted.h1List[0]) || '';
      crawlResult.url = effectiveUrl;

      // Verify HTTP status codes in parallel
      if (extracted.links && extracted.links.length > 0) {
        await this.checkLinkStatuses(extracted.links);
      }
      if (this.isCancellationRequested()) return;

      // Classify and check discovered links
      const internalLinks = [];
      const externalLinks = [];
      let customLinks = 0;

      for (const link of crawlResult.links) {
        if (link.isInsideCustom) customLinks++;

        const linkRecord = {
          sourceUrl: crawlResult.url,
          targetUrl: link.url,
          rawHref: link.rawHref,
          anchorText: link.anchorText,
          linkType: link.linkType,
          isInternal: link.linkType === 'Internal' || link.isInternal === true,
          rel: link.rel,
          isNofollow: link.isNofollow,
          isInsideCustom: link.isInsideCustom,
          statusCode: link.statusCode ?? null,
          finalStatusCode: link.finalStatusCode ?? null,
          finalUrl: link.finalUrl || '',
          redirectChain: link.redirectChain || [],
          redirectCount: link.redirectCount || 0,
          redirectError: link.redirectError || null
        };
        this.allLinks.push(linkRecord);

        const isInternal = link.linkType === 'Internal' || link.isInternal;
        if (isInternal) {
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
      if (this.isCancellationRequested()) return;
      httpFailed = true;
      crawlResult.statusCode = crawlResult.statusCode === 200 ? 500 : (crawlResult.statusCode || 500);
      crawlResult.statusText = err.name || 'Crawl Error';
      crawlResult.error = err.message;
      this.stats.errorsCount++;
    }

    if (this.isCancellationRequested()) return;

    if (browserFailure && !httpFailed) {
      crawlResult.error = `Browser rendering failed; Direct DOM fallback may not include client-rendered content: ${browserFailure.message}`;
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

  async processPage(item, workerId, retryAttempt = 0) {
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
      metaKeywords: '',
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
      resources: [],
      renderMode: 'browser',
      renderError: null,
      error: null,
      timestamp: new Date().toISOString()
    };

    try {
      // Keep the unrendered response alongside the browser DOM. Besides the
      // source/DOM comparison, this rescues crawlable navigation if a target
      // serves an automation browser a stripped page or a challenge shell.
      const sourceSnapshotPromise = this.fetchSourceSnapshot(url).catch(() => null);
      pageContext = await this.createPageContextWithTimeout();
      if (this.isCancellationRequested()) return;
      page = pageContext.page;
      page.setDefaultTimeout(this.pageTimeoutMs);
      const observedResources = new Map();
      const captureResourceResponse = response => {
        const resourceType = response.request().resourceType();
        const typeMap = { stylesheet: 'Stylesheet', script: 'Script', image: 'Image', media: 'Media', font: 'Font' };
        if (!typeMap[resourceType]) return;
        const resourceUrl = response.url();
        const headers = response.headers();
        const parsedSize = Number.parseInt(headers['content-length'] || '', 10);
        observedResources.set(this.resourceKey(resourceUrl, typeMap[resourceType]), {
          url: resourceUrl,
          rawUrl: resourceUrl,
          resourceType: typeMap[resourceType],
          element: 'network',
          attribute: '',
          statusCode: response.status(),
          sizeBytes: Number.isFinite(parsedSize) ? parsedSize : null,
          discoveryStatus: 'Loaded'
        });
      };
      page.on('response', captureResourceResponse);

      let mainResponse = null;
      try {
        mainResponse = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: this.pageTimeoutMs
        });
      } catch (navErr) {
        if (this.isCancellationRequested()) throw navErr;
        mainResponse = await page.goto(url, { waitUntil: 'load', timeout: this.pageTimeoutMs }).catch(() => null);
      }

      if (this.isCancellationRequested()) return;

      const effectiveUrl = page.url() || url;
      this.adoptSeedRedirect(effectiveUrl, depth);
      this.registerRedirectDestination(url, effectiveUrl);

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

      // Allow Nuxt/Next/SPA routes to hydrate before extracting their DOM.
      await page.waitForFunction(() => {
        const bodyText = document.body?.innerText?.trim() || '';
        return document.querySelectorAll('a[href]').length > 0 || bodyText.length > 200;
      }, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (this.isCancellationRequested()) return;

      // Auto-scroll for lazy loaded widgets
      if (this.autoScroll) {
        await this.browserManager.autoScroll(page, 2000);
      }
      if (this.isCancellationRequested()) return;

      const sourceSnapshot = await sourceSnapshotPromise;
      const sourceHtml = sourceSnapshot?.html || await mainResponse?.text().catch(() => '') || '';
      const renderedHtml = await page.content().catch(() => '');
      crawlResult.renderComparison = SiteCrawler.compareSourceAndRenderedHtml(sourceHtml, renderedHtml);

      // Extract all page metadata, links, and custom content
      const extracted = await Extractor.extractPageData(page, effectiveUrl, this.baseOrigin, {
        customSelector: this.customContentSelector
      });
      if (this.isCancellationRequested()) return;
      if (sourceHtml) {
        const sourceExtracted = Extractor.extractFromHtml(sourceHtml, sourceSnapshot?.url || effectiveUrl, this.baseOrigin, { customSelector: this.customContentSelector, cheerio });
        // Only supplement the DOM when it is clearly missing navigation. A
        // normal JavaScript page keeps its rendered links untouched.
        if (sourceExtracted.links.length > extracted.links.length + 3) {
          extracted.links = this.mergeDiscoveredLinks(extracted.links, sourceExtracted.links);
        }
      }
      extracted.links = this.normalizeInternalLinkAliases(extracted.links);
      page.off('response', captureResourceResponse);

      // The page is no longer needed once its DOM has been extracted. Releasing it
      // before link checks keeps Chromium memory stable on constrained cloud hosts.
      await this.closePageContext(pageContext);
      pageContext = null;
      page = null;

      // Verify HTTP status code for every internal and external link in parallel
      if (extracted.links && extracted.links.length > 0) {
        await this.checkLinkStatuses(extracted.links);
      }
      if (this.isCancellationRequested()) return;

      crawlResult.title = extracted.title;
      crawlResult.url = effectiveUrl;
      crawlResult.metaDescription = extracted.metaDescription;
      crawlResult.metaKeywords = extracted.metaKeywords;
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
      crawlResult.resources = this.mergeResources(extracted.resources, observedResources);

      if (extracted.customContent && extracted.customContent.detected) {
        this.stats.customDetectedCount++;
      }

      let internalCount = 0;
      let externalCount = 0;
      let customLinksCount = 0;

      for (const link of extracted.links) {
        if (link.isInsideCustom) customLinksCount++;

        const linkRecord = {
          sourceUrl: crawlResult.url,
          targetUrl: link.url,
          rawHref: link.rawHref,
          anchorText: link.anchorText,
          linkType: link.linkType,
          isInternal: link.linkType === 'Internal' || link.isInternal === true,
          statusCode: link.statusCode || 200,
          isInsideCustom: link.isInsideCustom,
          isNofollow: link.isNofollow,
          pageDepth: depth,
          finalStatusCode: link.finalStatusCode ?? null,
          finalUrl: link.finalUrl || '',
          redirectChain: link.redirectChain || [],
          redirectCount: link.redirectCount || 0,
          redirectError: link.redirectError || null
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
      if (pageContext) {
        await this.closePageContext(pageContext);
        pageContext = null;
      }

      if (this.isCancellationRequested()) return;

      const browserError = err instanceof Error ? err : new Error(String(err));
      const canRestart = !this.isCancellationRequested() && retryAttempt < 1 && this.isBrowserDisconnectError(browserError);

      if (canRestart) {
        console.warn(`Chromium became unavailable while rendering ${url}. Restarting it and retrying this URL once.`);
        this.stats.browserRestartsCount++;
        this.engineMode = 'recovering';
        this.engineError = browserError.message;
        this.emit('engineSelected', this.getEngineStatus());

        try {
          await this.browserManager.restart(`render failure for ${url}`);
          this.engineMode = 'browser';
          this.engineProvider = this.browserManager.provider;
          this.engineError = null;
          this.emit('engineSelected', this.getEngineStatus());
          await this.processPage(item, workerId, retryAttempt + 1);
          return;
        } catch (restartError) {
          browserError.message = `${browserError.message}; Chromium restart failed: ${restartError.message}`;
        }
      }

      // Keep browser mode enabled for later URLs. A single problematic route should
      // not force the rest of a JavaScript site into an unrendered HTTP-only crawl.
      console.warn(`Browser rendering failed for ${url} (${browserError.message}). Falling back for this URL only.`);
      this.stats.browserFallbacksCount++;
      this.engineMode = 'browser';
      this.engineProvider = this.browserManager.provider;
      this.engineError = `Last page fallback (${url}): ${browserError.message}`;
      this.emit('engineSelected', this.getEngineStatus());
      await this.processPageHttp(item, workerId, browserError);
      return;
    } finally {
      if (pageContext) {
        await this.closePageContext(pageContext);
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

  isBrowserDisconnectError(error) {
    const message = error?.message || String(error || '');
    return /target (?:page, )?context or browser has been closed|browser has been closed|browser closed|browser.*disconnected|browser context creation timed out|page crashed|target closed/i.test(message);
  }

  resourceKey(url, resourceType) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return `${resourceType}|${parsed.toString()}`;
    } catch {
      return `${resourceType}|${String(url || '')}`;
    }
  }

  mergeResources(declaredResources = [], observedResources = new Map()) {
    const merged = new Map();
    for (const resource of declaredResources || []) {
      const key = this.resourceKey(resource.url, resource.resourceType);
      if (merged.has(key)) continue;
      const observed = observedResources.get(key);
      merged.set(key, {
        ...resource,
        ...(observed || {}),
        discoveryStatus: observed?.discoveryStatus || (['Image', 'Media', 'Font'].includes(resource.resourceType) ? 'Blocked by crawler' : 'Not observed')
      });
    }
    for (const [key, observed] of observedResources) {
      if (!merged.has(key)) merged.set(key, observed);
    }
    return [...merged.values()];
  }

  async createPageContextWithTimeout() {
    let timedOut = false;
    let timeoutId = null;
    let removeAbortListener = null;
    const contextPromise = this.browserManager.createPageContext().then(async pageContext => {
      this.activePageContexts.add(pageContext);
      if (timedOut || this.isCancellationRequested()) await this.closePageContext(pageContext);
      return pageContext;
    });

    try {
      return await Promise.race([
        contextPromise,
        new Promise((resolve, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Browser context creation timed out after ${this.pageTimeoutMs}ms`));
          }, this.pageTimeoutMs);
        }),
        new Promise((resolve, reject) => {
          const signal = this.abortController?.signal;
          if (!signal) return;
          if (signal.aborted) return reject(new Error('Crawl cancelled while creating browser context'));
          const onAbort = () => reject(new Error('Crawl cancelled while creating browser context'));
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        })
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (removeAbortListener) removeAbortListener();
    }
  }

  async checkLinkStatuses(links) {
    let timeoutId = null;
    let removeAbortListener = null;
    const completed = await Promise.race([
      this.statusChecker.checkLinksInParallel(
        links,
        this.linkCheckConcurrency,
        this.linkCheckDeadlineMs,
        this.abortController?.signal
      ).then(() => true),
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve(false), this.linkCheckDeadlineMs);
      }),
      new Promise(resolve => {
        const signal = this.abortController?.signal;
        if (!signal) return resolve(false);
        if (signal.aborted) return resolve(false);
        const onAbort = () => resolve(false);
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      })
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    if (removeAbortListener) removeAbortListener();
    if (!completed && !this.isCancellationRequested()) {
      console.warn(`Link verification reached its ${this.linkCheckDeadlineMs}ms page deadline; continuing the crawl.`);
    }
  }

  async closePageContext(pageContext) {
    if (!pageContext?.context) return;
    this.activePageContexts.delete(pageContext);
    let timeoutId = null;
    await Promise.race([
      pageContext.context.close().catch(() => {}),
      new Promise(resolve => {
        timeoutId = setTimeout(resolve, this.contextCloseTimeoutMs);
      })
    ]);
    if (timeoutId) clearTimeout(timeoutId);
  }

  /**
   * Add a candidate URL to the crawl queue if permitted by scope and depth
   */
  addToQueue(targetUrl, depth, sourceUrl) {
    if (this.crawlScope === 'single-url' || depth > this.maxDepth) return false;
    const normalized = Extractor.normalizeUrl(targetUrl, this.baseOrigin);
    if (!normalized || !this.isUrlAllowedInScope(normalized)) return false;
    const effectiveUrl = this.redirectAliases.get(normalized) || normalized;
    if (this.visited.has(effectiveUrl) || this.queued.has(effectiveUrl)) return false;

    this.queued.add(effectiveUrl);
    this.queue.push({
      url: effectiveUrl,
      depth,
      sourceUrl
    });
    this.stats.pagesQueued = this.queue.length;
    return true;
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
        if (!this.isWwwAlias(urlObj.hostname, this.baseHostname) || !urlObj.pathname.startsWith(this.basePathname)) {
          return false;
        }
      } else if (this.crawlScope === 'domain') {
        if (!this.isWwwAlias(urlObj.hostname, this.baseHostname)) {
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
    if (!this.isRunning || this.isCancelled) return;
    this.isCancelled = true;
    this.isPaused = false;
    this.queue = [];
    this.abortController?.abort();
    for (const pageContext of [...this.activePageContexts]) {
      this.closePageContext(pageContext).catch(() => {});
    }
    this.emit('stopping');
  }

  isCancellationRequested() {
    return this.isCancelled || Boolean(this.abortController?.signal.aborted);
  }

  getAbortSignal(timeoutMs) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return this.abortController?.signal
      ? AbortSignal.any([this.abortController.signal, timeoutSignal])
      : timeoutSignal;
  }

  async waitForDelay(delayMs) {
    const signal = this.abortController?.signal;
    if (!signal || signal.aborted || delayMs <= 0) return;
    await new Promise(resolve => {
      const timeoutId = setTimeout(done, delayMs);
      const onAbort = () => done();
      function done() {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  getConfigSummary() {
    return {
      seedUrl: this.seedUrl,
      crawlScope: this.crawlScope,
      maxDepth: this.maxDepth,
      maxPages: this.maxPages,
      noPageLimit: this.noPageLimit,
      concurrency: this.concurrency,
      respectRobotsTxt: this.respectRobotsTxt,
      customContentSelector: this.customContentSelector,
      excludePatternsCount: this.excludePatterns.length,
      includePatternsCount: this.includePatterns.length,
      autoScroll: this.autoScroll
    };
  }

  getEngineStatus() {
    return {
      mode: this.engineMode,
      provider: this.engineProvider,
      error: this.engineError
    };
  }
}
