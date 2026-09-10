// Owns the lifecycle of live, in-memory crawls. Express routes use this
// service instead of directly manipulating crawler Maps and worker state.
export class CrawlCoordinator {
  constructor({ storage, capacity, onEvent = () => {}, onCapacityChange = () => {} }) {
    this.storage = storage;
    this.capacity = capacity;
    this.onEvent = onEvent;
    this.onCapacityChange = onCapacityChange;
    this.sessions = new Map();
    this.activeCrawlers = new Set();
  }

  get(sessionId) {
    const record = this.sessions.get(sessionId);
    if (record) record.updatedAt = Date.now();
    return record || null;
  }

  attach(sessionId, crawlId, crawler) {
    const record = { crawler, crawlId, updatedAt: Date.now() };
    this.sessions.set(sessionId, record);
    return record;
  }

  remove(sessionId) {
    return this.sessions.delete(sessionId);
  }

  move(fromSessionId, toSessionId, record = this.sessions.get(fromSessionId)) {
    if (!record || fromSessionId === toSessionId) return record || null;
    this.sessions.delete(fromSessionId);
    record.updatedAt = Date.now();
    this.sessions.set(toSessionId, record);
    return record;
  }

  findSessionId(crawler) {
    for (const [sessionId, record] of this.sessions) {
      if (record?.crawler === crawler) return sessionId;
    }
    return null;
  }

  findActiveByCrawlId(crawlId) {
    for (const [sessionId, record] of this.sessions) {
      if (record.crawlId === crawlId && record.crawler?.isRunning && !record.crawler.isSuspended) {
        return { sessionId, record };
      }
    }
    return null;
  }

  hasActiveCrawl(crawlId) {
    return Boolean(this.findActiveByCrawlId(crawlId));
  }

  prune({ ttlMs, maxRetainedSessions }) {
    const now = Date.now();
    for (const [sessionId, record] of this.sessions) {
      if (!record.crawler.isRunning && now - record.updatedAt > ttlMs) this.sessions.delete(sessionId);
    }
    if (this.sessions.size <= maxRetainedSessions) return;
    const removable = [...this.sessions.entries()]
      .filter(([, record]) => !record.crawler.isRunning)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    while (this.sessions.size > maxRetainedSessions && removable.length > 0) {
      this.sessions.delete(removable.shift()[0]);
    }
  }

  getCapacity() {
    let activeCrawls = 0;
    for (const crawler of this.activeCrawlers) {
      if (crawler.isRunning) activeCrawls++;
    }
    return {
      activeCrawls,
      maxConcurrentCrawls: this.capacity.maxConcurrentCrawls,
      availableSlots: Math.max(0, this.capacity.maxConcurrentCrawls - activeCrawls),
      maxWorkersPerCrawl: this.capacity.maxWorkersPerCrawl,
      maxUnlimitedCrawlPages: this.capacity.maxUnlimitedCrawlPages,
      linkCheckConcurrency: this.capacity.linkCheckConcurrency,
      linkCheckDeadlineMs: this.capacity.linkCheckDeadlineMs
    };
  }

  start(sessionId, crawlId, crawler) {
    let persistenceChain = Promise.resolve();
    const queuePersistence = task => {
      persistenceChain = persistenceChain
        .then(task)
        .catch(error => console.error(`Failed to persist crawl ${crawlId}:`, error.message));
      return persistenceChain;
    };
    const persistCheckpoint = () => queuePersistence(() => this.storage.updateCrawlQueue(crawlId, crawler.getResumeState()));
    this.attach(sessionId, crawlId, crawler);
    this.activeCrawlers.add(crawler);
    const sendCrawlerEvent = (eventType, data) => {
      const activeSessionId = this.findSessionId(crawler);
      if (activeSessionId) this.onEvent(activeSessionId, eventType, data);
    };

    crawler.on('started', data => {
      sendCrawlerEvent('started', { ...data, historyAudit: crawler.historyAudit || null });
      queuePersistence(() => this.storage.updateCrawl(crawlId, {
        status: 'running', stats: crawler.stats, engine: crawler.getEngineStatus(), started: true
      }));
    });
    crawler.on('engineSelected', data => sendCrawlerEvent('engineSelected', data));
    let publishedLinkCount = 0;
    crawler.on('pageCrawled', data => {
      const links = crawler.allLinks.slice(publishedLinkCount);
      publishedLinkCount = crawler.allLinks.length;
      if (crawler.historyAudit) crawler.historyAudit.totalPages = crawler.stats.pagesCrawled;
      sendCrawlerEvent('pageCrawled', { ...data, links, historyAudit: crawler.historyAudit || null });
      queuePersistence(() => this.storage.savePage(crawlId, data.result));
      if (crawler.stats.pagesCrawled % 10 === 0) persistCheckpoint();
    });
    crawler.on('paused', (data = {}) => {
      sendCrawlerEvent('paused', data);
      queuePersistence(() => this.storage.updateCrawl(crawlId, { status: 'paused', stats: crawler.stats, engine: crawler.getEngineStatus() }));
      persistCheckpoint();
    });
    crawler.on('resumed', (data = {}) => {
      sendCrawlerEvent('resumed', data);
      queuePersistence(() => this.storage.updateCrawl(crawlId, { status: 'running', stats: crawler.stats, engine: crawler.getEngineStatus() }));
    });
    crawler.on('stopping', () => {
      sendCrawlerEvent('stopping', {});
      queuePersistence(() => this.storage.updateCrawl(crawlId, { status: 'stopping', stats: crawler.stats, engine: crawler.getEngineStatus() }));
    });
    crawler.on('stopped', data => {
      sendCrawlerEvent('stopped', data);
      queuePersistence(() => this.storage.updateCrawl(crawlId, { status: 'stopped', stats: data.stats, engine: data.engine }));
      persistCheckpoint();
    });
    crawler.on('suspended', data => {
      queuePersistence(() => this.storage.updateCrawl(crawlId, { status: 'paused', stats: data.stats, engine: data.engine }));
      persistCheckpoint();
    });
    crawler.on('completed', data => {
      sendCrawlerEvent('completed', data);
      queuePersistence(() => this.storage.updateCrawl(crawlId, {
        status: 'completed', stats: data.stats, engine: data.engine, completed: true
      }));
      queuePersistence(() => this.storage.updateCrawlQueue(crawlId, null));
    });
    crawler.on('error', data => sendCrawlerEvent('error', data));

    const crawlPromise = crawler.start();
    this.onCapacityChange(this.getCapacity());
    crawlPromise
      .catch(error => {
        console.error('Crawler engine error:', error);
        sendCrawlerEvent('error', { message: error.message });
      })
      .finally(async () => {
        await persistenceChain;
        this.activeCrawlers.delete(crawler);
        this.onCapacityChange(this.getCapacity());
      });
    return crawlPromise;
  }
}
